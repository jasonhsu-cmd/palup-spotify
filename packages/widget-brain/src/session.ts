import type { Brain } from "./brain.js";
import type { Decision, ProactivityLevel, Signals } from "./types.js";

// Conversation state (§6A): the stateless brain decides per turn; the Session carries the state
// that spans turns — safety latch (INV-A), open issues (INV-B, persist within + across sessions),
// and the one proactivity budget for the whole conversation (INV-E).

const BUDGET: Record<ProactivityLevel, number> = { cautious: 1, balanced: 2, confident: 4 };
const RESOLUTION = ["thanks", "thank you", "all set", "that fixed", "resolved", "got it", "perfect", "sorted"];

export interface SessionState {
  safetyLatched: boolean;
  openIssues: string[];
  pitchesUsed: number;
}

export interface SessionStore {
  load(sessionId: string): Promise<SessionState | undefined>;
  save(sessionId: string, state: SessionState): Promise<void>;
}

/** In-memory store — for tests/dev. A durable adapter (RuntimeStatePort → Cloud SQL) implements the
 * same async interface so conversation state survives restart/scale-to-zero and is shared across
 * instances (see widget-backend/src/session-store.ts). */
export function createMemorySessionStore(): SessionStore {
  const m = new Map<string, SessionState>();
  return {
    load: async (id) => m.get(id),
    save: async (id, s) => {
      m.set(id, { ...s, openIssues: [...s.openIssues] });
    },
  };
}

export interface Session {
  send(message: string, signals?: Signals): Promise<Decision>;
  readonly state: SessionState;
}

export interface SessionOptions {
  sessionId?: string;
  store?: SessionStore;
  level?: ProactivityLevel;
}

export async function createSession(brain: Brain, opts: SessionOptions = {}): Promise<Session> {
  const level = opts.level ?? "balanced";
  const restored = opts.sessionId && opts.store ? await opts.store.load(opts.sessionId) : undefined;
  const state: SessionState = restored
    ? { ...restored, openIssues: [...restored.openIssues] }
    : { safetyLatched: false, openIssues: [], pitchesUsed: 0 };

  const persist = async () => {
    if (opts.sessionId && opts.store) await opts.store.save(opts.sessionId, state);
  };

  return {
    state,
    async send(message: string, signals: Signals = {}): Promise<Decision> {
      const lc = message.toLowerCase();
      // Merge carried state INTO signals so the stateless brain sees the latch + open issues.
      const merged: Signals = {
        ...signals,
        proactivityLevel: signals.proactivityLevel ?? level,
        safetyLatched: state.safetyLatched || Boolean(signals.safetyLatched),
        openIssues: [...state.openIssues, ...(signals.openIssues ?? [])],
      };
      let d = await brain.decide(merged, message);

      if (d.mode === "safety") state.safetyLatched = true; // INV-A: latches for the conversation.

      if (d.mode === "support") {
        if (RESOLUTION.some((r) => lc.includes(r))) state.openIssues = [];
        else if (!merged.openIssues?.length) state.openIssues = [`issue@${state.openIssues.length + 1}`];
      }

      // INV-E: one budget across the whole conversation; switching modes never refills it.
      if (d.pitch !== "none") {
        if (state.pitchesUsed >= BUDGET[level]) {
          d = {
            ...d,
            pitch: "none",
            outbound: false,
            flags: [
              ...d.flags.filter((f) => !f.startsWith("pitch:") && f !== "outbound"),
              "budget_capped",
              "no_pitch",
            ],
          };
        } else {
          state.pitchesUsed += 1;
        }
      }

      await persist();
      return d;
    },
  };
}
