import type { Brain } from "./brain.js";
import type { Decision, Mode, Mood, ProactivityLevel, Signals } from "./types.js";
import { classifySupportIntent, extractOrderId } from "./support.js";

// Conversation state (§6A): the stateless brain decides per turn; the Session carries the state
// that spans turns — safety latch (INV-A), open issues (INV-B, persist within + across sessions),
// and the one proactivity budget for the whole conversation (INV-E).

const BUDGET: Record<ProactivityLevel, number> = { cautious: 1, balanced: 2, confident: 4 };
const RESOLUTION = ["thanks", "thank you", "all set", "that fixed", "resolved", "got it", "perfect", "sorted"];
const NEGATIVE_MOODS: Mood[] = ["frustrated", "upset", "anxious"];

/** A real, deterministic summary of a support issue (§6A: open_issues holds actual issues, not
 * `issue@N` placeholders) — the same classifier the brain uses, plus the order id when named. */
function summarizeIssue(message: string): string {
  const intent = classifySupportIntent(message);
  const orderId = extractOrderId(message);
  const base = intent === "general" ? "support" : intent;
  return orderId ? `${base} #${orderId}` : base;
}

export interface SessionState {
  safetyLatched: boolean;
  openIssues: string[];
  pitchesUsed: number;
  /** §6A active_intent — the arbitrated mode of the CURRENT turn; re-classified every turn (not sticky). */
  activeIntent?: Mode;
  /** §6A escalation_pending — a turn asked for a human; cleared only on a human handoff (escalation
   * hands off the mode), never by a topic change or an unrelated resolution. */
  escalationPending: boolean;
  /** §4 mood — TRANSIENT: the current turn's value only, overwritten each turn. Never accumulated into a
   * persistent mood profile ("not stored as a persistent mood profile"). */
  mood?: Mood;
  /** INV-D browsing_context — the last sales-turn topic, preserved across a support/safety detour so a
   * single non-pushy "pick up where you left off?" resume is possible (offered, not pushed). */
  browsingContext?: string;
  /** INV-D — the resume offer was already made once; never repeat it. */
  resumeOffered: boolean;
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
  /**
   * INV-D: at most once, return a non-pushy "pick up where you left off?" offer for the preserved
   * browsing context — but only when the detour is fully over (no open issue, safety not latched, no
   * pending escalation, mood not negative). Returns undefined when a resume isn't appropriate or was
   * already offered. Offered, never pushed: the caller decides whether/when to surface it.
   */
  resumeOffer(): string | undefined;
  readonly state: SessionState;
}

export interface SessionOptions {
  sessionId?: string;
  store?: SessionStore;
  level?: ProactivityLevel;
  /**
   * When true (default), send() persists the advanced state via `store` itself. Set false when the
   * caller wants to persist the state atomically WITH something else (e.g. the per-turn audit record in
   * one transaction) — then the caller reads `session.state` and persists it. See widget-backend /chat.
   */
  autoPersist?: boolean;
}

export async function createSession(brain: Brain, opts: SessionOptions = {}): Promise<Session> {
  const level = opts.level ?? "balanced";
  const restored = opts.sessionId && opts.store ? await opts.store.load(opts.sessionId) : undefined;
  const state: SessionState = restored
    ? { escalationPending: false, resumeOffered: false, ...restored, openIssues: [...restored.openIssues] }
    : { safetyLatched: false, openIssues: [], pitchesUsed: 0, escalationPending: false, resumeOffered: false };

  const autoPersist = opts.autoPersist ?? true;
  const persist = async () => {
    if (autoPersist && opts.sessionId && opts.store) await opts.store.save(opts.sessionId, state);
  };

  return {
    state,
    resumeOffer(): string | undefined {
      // INV-D: offered at most once, and only when the detour is genuinely over.
      if (state.resumeOffered || !state.browsingContext) return undefined;
      // INV-B/INV-A: any open issue, a latched safety event, or a pending escalation still gates.
      if (state.openIssues.length > 0 || state.safetyLatched || state.escalationPending) return undefined;
      // INV-C (resume slow): only when mood is neutral-or-positive — i.e. not a negative-braking mood
      // (matches the brain's serve-and-brake gate; unknown mood defaults to neutral per §4).
      if (state.mood && NEGATIVE_MOODS.includes(state.mood)) return undefined;
      state.resumeOffered = true;
      return `Want to pick up where you left off — ${state.browsingContext}?`;
    },
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

      // §4: mood is transient — snapshot THIS turn only (overwrite; never accumulate a mood profile).
      state.mood = signals.mood;
      // §6A active_intent: the arbitrated mode of this turn (re-classified every turn, not sticky).
      state.activeIntent = d.mode;

      if (d.mode === "safety") state.safetyLatched = true; // INV-A: latches for the conversation.

      if (d.mode === "support") {
        // Resolution confirmation closes the open issue(s); otherwise record the REAL issue summary
        // (§6A: a genuine issue, not an `issue@N` placeholder) on a first, uncarried support turn.
        if (RESOLUTION.some((r) => lc.includes(r))) state.openIssues = [];
        else if (!merged.openIssues?.length) state.openIssues = [summarizeIssue(message)];
      }

      // §6A escalation_pending: an escalating turn arms it; a human handoff clears it (escalation hands
      // off the mode). Not cleared by a topic change or an unrelated resolution.
      if (signals.handoff) state.escalationPending = false;
      else if (d.escalateToHuman) state.escalationPending = true;

      // INV-D: preserve the last sales-turn topic so the detour can later be resumed as help.
      if (d.mode === "sales") state.browsingContext = message.trim().slice(0, 200);

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
