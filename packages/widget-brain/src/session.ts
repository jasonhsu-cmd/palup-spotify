import type { Brain } from "./brain.js";
import type { Decision, Disposition, HistoryTurn, Mode, Mood, ProactivityLevel, Signals } from "./types.js";
import { classifySupportIntent, extractOrderId } from "./support.js";

// Conversation state (§6A): the stateless brain decides per turn; the Session carries the state
// that spans turns — safety latch (INV-A), open issues (INV-B, persist within + across sessions),
// and the one proactivity budget for the whole conversation (INV-E).

const BUDGET: Record<ProactivityLevel, number> = { cautious: 1, balanced: 2, confident: 4 };
const NEGATIVE_MOODS: Mood[] = ["frustrated", "upset", "anxious"];

/**
 * A shopper saying they are DONE. This used to be one flat `RESOLUTION` list that also contained
 * "thanks", "thank you", "got it" and "perfect" — pure pleasantries — and a substring hit on any of them
 * cleared every open issue. Measured consequence: "the bottle arrived cracked and leaking" then "thanks"
 * emptied the ledger, and the next ordinary product question came back `mode: sales, pitch: cross_sell`.
 * The identical conversation with "ok" instead of "thanks" stayed `support` / `no_pitch`.
 *
 * So a confirmation now needs an actual STATEMENT ABOUT THE ISSUE, not politeness. "thanks" alone is not
 * enough; "thanks, that fixed it" is, because of the second clause. Bias is deliberate and one-sided: an
 * issue held open too long only costs a pitch we chose not to make, while an issue dropped too early
 * means pitching at a shopper holding a broken product (§8a invariant 13).
 */
export const CONFIRMED_RESOLVED = [
  "all set",
  "all sorted",
  "sorted now",
  "that fixed",
  "that's fixed",
  "thats fixed",
  "it's fixed",
  "its fixed",
  "that worked",
  "that did it",
  "resolved",
  "no longer an issue",
  "sorted it",
  "all good now",
];

/** Politeness is not a resolution — kept as an explicit, named list so the distinction is testable and
 * so a future edit cannot quietly slide one of these back into `CONFIRMED_RESOLVED`. */
export const PLEASANTRIES = ["thanks", "thank you", "cheers", "got it", "perfect", "great", "ok", "okay"];

export function isResolutionConfirmed(lc: string): boolean {
  return CONFIRMED_RESOLVED.some((r) => lc.includes(r));
}

/** The label `summarizeIssue` produces when the turn names no specific problem. */
const GENERAL_ISSUE = "support";

/** Cap the ledger so a shopper (or a loop) cannot grow session state without bound. Distinct support
 * intents are few, so this is a backstop, not a working limit; the OLDEST entries are kept because the
 * first-reported issue is the one most likely still genuinely unresolved. */
const MAX_OPEN_ISSUES = 8;

const dedupeIssues = (issues: string[]): string[] => [...new Set(issues)].slice(0, MAX_OPEN_ISSUES);

/** A real, deterministic summary of a support issue (§6A: open_issues holds actual issues, not
 * `issue@N` placeholders) — the same classifier the brain uses, plus the order id when named. */
function summarizeIssue(message: string): string {
  const intent = classifySupportIntent(message);
  const orderId = extractOrderId(message);
  const base = intent === "general" ? GENERAL_ISSUE : intent;
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
  /**
   * INV-D — the shopper has actually LEFT the browsing topic (at least one non-sales turn since the topic
   * was last recorded). Without this, `resumeOffer()` fired on the very turn that set the context and
   * offered to resume what the shopper was doing right now: measured, turn 1 of a fresh session returned
   * "Want to pick up where you left off — do you have a vitamin C serum??". You cannot resume a detour you
   * have not taken. Nobody saw it because `resumeOffer()` had no production caller until it was wired.
   */
  detoured?: boolean;
  // ── Shopper-disposition program PR-4 (flag DISPOSITION_BEHAVIORAL, consumed only in brain.ts) ──────
  // CROSS-TURN CONTROL COUNTERS ONLY — explicitly NOT a persona profile: no observed axes/values, no
  // free text, nothing keyed to a persistent shopper identity. Transient, dies with the session like
  // every other field above. Maintained here UNCONDITIONALLY (session.ts has no flag of its own); the
  // flag-gated consumer lives entirely in brain.ts, so with the flag OFF these are tracked but inert.
  /** Armed by a `behavioral: ["pitch_declined"]` event; disarmed the moment brain.ts actually suppresses
   * the next proactive pitch because of it (a true ONE-STRIKE, not a standing brake). */
  pitchDeclined: boolean;
  /** Running tally of `repeat_question` events this session (not a one-strike). */
  repeatQuestionCount: number;
  /** Running tally of `rage` events this session (not a one-strike). */
  rageCount: number;
  // ── Shopper-disposition program PR-8 (in-session fallback; consumed only in brain.ts) ──────────────
  /**
   * TRANSIENT, control-only, STYLE-ONLY fallback for when durable cross-visit memory is off or the
   * shopper hasn't consented: captures THIS session's own OBSERVED `personaStyle` (never the brain's
   * internal classifier output, which never leaves brain.decide()) so a LATER turn in the SAME session
   * that doesn't re-supply `personaStyle` can still get the same voice treatment. Explicitly NOT a
   * persona profile: at most one "style" entry, no free text, no cross-session persistence. Dies with
   * the session (never written here unless/until a `personaStyle` is actually observed — so a session
   * with no persona signal never gains this key at all), and is EXCLUDED from the guest→account
   * `merge.ts` migration by construction: `merge.ts` only ever reads/writes durable vector-store facts,
   * never `SessionState` — there is no code path from here into it.
   */
  sessionDisposition?: Disposition[];
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
  /**
   * `history` is the CLIENT's bounded recent transcript for in-session multi-turn memory (§6A). It is
   * passed straight to the brain for model context and is NEVER written to SessionState — the state
   * stays control-only (safety latch / open issues / pitch budget), no shopper transcript persisted.
   */
  send(message: string, signals?: Signals, history?: HistoryTurn[]): Promise<Decision>;
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
  // Two DIFFERENT things, deliberately kept apart.
  //
  // `budgetLevel` sizes INV-E's one-per-conversation pitch budget and must always resolve to something.
  //
  // `explicitLevel` is what (if anything) we STAMP onto the signals we hand the brain. It used to be
  // `opts.level ?? "balanced"` — always defined — so `send()` always set `signals.proactivityLevel`, and
  // brain.ts's `signals.proactivityLevel ?? policy.proactivityDefault` fallback was DEAD CODE on every
  // request that went through a Session. Leaving it undefined when the caller gave no level is what makes
  // that fallback reachable, so a policy's own dial is honoured instead of being silently overwritten
  // with "balanced".
  const budgetLevel: ProactivityLevel = opts.level ?? "balanced";
  const explicitLevel = opts.level;
  const restored = opts.sessionId && opts.store ? await opts.store.load(opts.sessionId) : undefined;
  const state: SessionState = restored
    ? {
        ...restored,
        // Deduped on restore as well: a record written before this fix (or by any future bug) must not
        // resurrect duplicates into a live session.
        openIssues: dedupeIssues(restored.openIssues ?? []),
        // EVERY backfilled field is listed AFTER the spread with `??`, uniformly. A persisted record
        // written before a field existed lacks the key entirely, so the `??` supplies the default.
        //
        // `escalationPending`/`resumeOffered` used to sit BEFORE the spread instead. That worked at
        // runtime for the same reason — a missing key does not overwrite — but because `SessionState`
        // declares both as REQUIRED, the compiler saw the spread as always clobbering them and flagged
        // two dead writes (TS2783). The previous comment here acknowledged the split and chose the
        // `??` form for the PR-4 fields only; this just applies it to all five, which is
        // behaviour-identical and type-honest.
        escalationPending: restored.escalationPending ?? false,
        resumeOffered: restored.resumeOffered ?? false,
        detoured: restored.detoured ?? false,
        pitchDeclined: restored.pitchDeclined ?? false,
        repeatQuestionCount: restored.repeatQuestionCount ?? 0,
        rageCount: restored.rageCount ?? 0,
      }
    : {
        safetyLatched: false,
        openIssues: [],
        pitchesUsed: 0,
        escalationPending: false,
        resumeOffered: false,
        detoured: false,
        pitchDeclined: false,
        repeatQuestionCount: 0,
        rageCount: 0,
      };

  const autoPersist = opts.autoPersist ?? true;
  const persist = async () => {
    if (autoPersist && opts.sessionId && opts.store) await opts.store.save(opts.sessionId, state);
  };

  return {
    state,
    resumeOffer(): string | undefined {
      // INV-D: offered at most once, and only when the detour is genuinely over.
      if (state.resumeOffered || !state.browsingContext) return undefined;
      // The shopper must actually have gone somewhere else and come back — see SessionState.detoured.
      if (!state.detoured) return undefined;
      // INV-B/INV-A: any open issue, a latched safety event, or a pending escalation still gates.
      if (state.openIssues.length > 0 || state.safetyLatched || state.escalationPending) return undefined;
      // INV-C (resume slow): only when mood is neutral-or-positive — i.e. not a negative-braking mood
      // (matches the brain's serve-and-brake gate; unknown mood defaults to neutral per §4).
      if (state.mood && NEGATIVE_MOODS.includes(state.mood)) return undefined;
      state.resumeOffered = true;
      // Trim the topic's own trailing punctuation: the template adds "?", and the raw shopper message
      // often ends in one already, which produced "… vitamin C serum??".
      return `Want to pick up where you left off — ${state.browsingContext.replace(/[?!.,;:\s]+$/, "")}?`;
    },
    async send(message: string, signals: Signals = {}, history: HistoryTurn[] = []): Promise<Decision> {
      const lc = message.toLowerCase();
      // Merge carried state INTO signals so the stateless brain sees the latch + open issues.
      const merged: Signals = {
        ...signals,
        proactivityLevel: signals.proactivityLevel ?? explicitLevel,
        safetyLatched: state.safetyLatched || Boolean(signals.safetyLatched),
        openIssues: [...state.openIssues, ...(signals.openIssues ?? [])],
        // Shopper-disposition program PR-4 (flag DISPOSITION_BEHAVIORAL, consumed only in brain.ts) —
        // carry the ARMED one-strike across turns: a pitch_declined from turns ago must still reach the
        // brain on the shopper's NEXT proactive turn, long after this turn's own signals.behavioral (if
        // any) has moved on. Merge, don't replace, so a genuinely new event this turn is preserved
        // alongside the carried one. Harmless when the brain's flag is off (never consumed).
        behavioral: state.pitchDeclined
          ? [...(signals.behavioral ?? []), "pitch_declined"]
          : signals.behavioral,
        // Shopper-disposition program PR-8 — carry the STICKY in-session style fallback forward every
        // turn (mirrors the `behavioral` carry above). `signals.personaStyle`, if supplied THIS turn,
        // already rides along via the `...signals` spread above and takes precedence in brain.ts; this
        // is only ever consulted as a fallback for a LATER turn that doesn't re-supply it.
        sessionDisposition: state.sessionDisposition,
      };
      // history threads to the brain for model context ONLY — it is deliberately NOT merged into signals
      // or state, so the persisted SessionState carries no shopper transcript (control-only).
      let d = await brain.decide(merged, message, history);

      // §4: mood is transient — snapshot THIS turn only (overwrite; never accumulate a mood profile).
      state.mood = signals.mood;
      // §6A active_intent: the arbitrated mode of this turn (re-classified every turn, not sticky).
      state.activeIntent = d.mode;

      // Shopper-disposition program PR-8 — capture THIS TURN's raw, caller-supplied `signals.personaStyle`
      // (never the brain's own classifier output, which stays internal to brain.decide()) into the
      // sticky, style-only session fallback. Deliberately conditional — unlike `mood` above, a turn with
      // NO personaStyle leaves the carried value untouched (that's the whole point of a fallback: it
      // must survive turns that don't re-supply it) AND never creates the key at all on a session that
      // never observed one (keeps `sessionDisposition` genuinely absent, not merely empty, exactly like
      // every other "only if observed" field on this state). At most one "style" entry — a later
      // observation replaces the prior one, never accumulates a history.
      if (signals.personaStyle) {
        const otherAxes = (state.sessionDisposition ?? []).filter((disp) => disp.axis !== "style");
        state.sessionDisposition = [
          ...otherAxes,
          { axis: "style", value: signals.personaStyle, provenance: "observed", confidence: 1 },
        ];
      }

      if (d.mode === "safety") state.safetyLatched = true; // INV-A: latches for the conversation.

      if (d.mode === "support") {
        // The ledger is a SET of the DISTINCT issues still open (§6A: real issues, not `issue@N`
        // placeholders). Two things used to go wrong here, both measured before this change:
        //
        // (1) The recording arm was `else if (!merged.openIssues?.length)` — it fired ONLY when nothing
        //     was open, so a second, DIFFERENT problem was silently dropped: "my order arrived late"
        //     then "also the bottle arrived cracked and leaking" left the ledger at ["order_status"] and
        //     never recorded the damage. support.ts's multi-issue rendering ("your X and your Y", "on
        //     them", "either" — support.ts:530-534) was therefore unreachable dead code.
        //
        // (2) A BARE PLEASANTRY counted as a resolution and wiped everything, which re-armed pitching:
        //     "cracked and leaking" -> ["damaged"] / no_pitch, then "thanks" -> [], then "do you have a
        //     bigger size?" -> mode SALES, pitch CROSS_SELL. The same turns with "ok" instead of "thanks"
        //     stayed support/no_pitch. One polite word was the whole difference, and §8a invariant 13
        //     ("no pitch into complaint; resolve first") is exactly what it defeated.
        //
        // So: a pleasantry is not a confirmation, and a confirmation never closes an issue that THIS
        // turn is reporting. When in doubt the issue STAYS OPEN — the failure mode of holding an issue
        // too long is a missed pitch, and the failure mode of dropping one is pitching at a shopper
        // holding a broken product.
        const reported = summarizeIssue(message);
        // Keyed off the INTENT, not the rendered label: a general question that happens to name an order
        // renders as "support #1234", which is not equal to GENERAL_ISSUE but is not a new problem either.
        const namesAProblem = classifySupportIntent(message) !== "general";
        const isNewIssue = namesAProblem && !state.openIssues.includes(reported);
        if (isNewIssue) {
          state.openIssues = dedupeIssues([...state.openIssues, reported]);
        } else if (isResolutionConfirmed(lc)) {
          state.openIssues = [];
        }
      }

      // §6A escalation_pending: an escalating turn arms it; a human handoff clears it (escalation hands
      // off the mode). Not cleared by a topic change or an unrelated resolution.
      if (signals.handoff) state.escalationPending = false;
      else if (d.escalateToHuman) state.escalationPending = true;

      // INV-D: preserve the last sales-turn topic so the detour can later be resumed as help. Skip an
      // empty turn — an agent-initiated proactive nudge (empty shopper message) has no browsing topic and
      // must not wipe the context captured on a real sales turn.
      if (d.mode === "sales" && message.trim()) state.browsingContext = message.trim().slice(0, 200);
      // A non-sales turn AFTER a topic was recorded is the detour INV-D exists for. Set here rather than in
      // resumeOffer() so it is part of the persisted state and survives a reconnect.
      else if (state.browsingContext && d.mode !== "sales") state.detoured = true;

      // INV-E: one budget across the whole conversation; switching modes never refills it.
      if (d.pitch !== "none") {
        if (state.pitchesUsed >= BUDGET[budgetLevel]) {
          d = {
            ...d,
            pitch: "none",
            outbound: false,
            // A PROACTIVE nudge (§5) has no shopper turn to answer, so an over-budget one must surface
            // NOTHING (INV-E one-strike: it can never nag). Blank its reply; a reactive answer is
            // untouched — only its pitch flag is dropped.
            reply: d.flags.includes("proactive:exit_intent") ? "" : d.reply,
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

      // Shopper-disposition program PR-4 — cross-turn CONTROL COUNTERS (not a persona profile; transient,
      // dies with the session like every other field on SessionState). Maintained from THIS turn's RAW
      // signals.behavioral (never the merged/carried array above, which would double-count the carry).
      // Session.ts has no DISPOSITION_BEHAVIORAL flag of its own — brain.ts is the sole gate that ever
      // turns these into an observable decision change, so this bookkeeping runs unconditionally.
      for (const ev of signals.behavioral ?? []) {
        if (ev === "pitch_declined") state.pitchDeclined = true; // arm the one-strike
        else if (ev === "repeat_question") state.repeatQuestionCount += 1;
        else if (ev === "rage") state.rageCount += 1;
      }
      // True one-strike: disarm the moment brain.ts actually consumed it to suppress a proactive pitch
      // (only happens on the flag-ON path — "disposition:one_strike" is never emitted with the flag off,
      // so a declined shopper simply stays armed, harmlessly, until the flag is enabled).
      if (d.flags.includes("disposition:one_strike")) state.pitchDeclined = false;

      await persist();
      return d;
    },
  };
}
