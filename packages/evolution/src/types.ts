import type { Policy } from "@palup/widget-brain";

/** How a candidate policy scored — the input the gate decides on. */
export interface PolicyMetrics {
  policyId: string;
  /** All safety/injection/isolation floor cases passed (a HARD gate — never tradeable). */
  safetyPass: boolean;
  /** All deterministic floor cases passed (no regression on the non-negotiables). */
  floorPass: boolean;
  /** 0..1 value/quality score (e.g. cross-family judge score on the subjective suite). */
  qualityScore: number;
  /**
   * Counter-metrics that must NOT worsen — an engagement/quality lift can never promote on its own if it
   * regresses these (ADR-0014 #5). returnRate/optOutRate are lower-is-better; escalationRecall is
   * HIGHER-is-better (recall of required escalations). These three are REQUIRED — absent/NaN/out-of-range
   * on either side fails the gate CLOSED (never fail-open). `complaintRate` (lower is better) is the one
   * counter-metric that stays OPTIONAL: no honest deterministic pre-promotion proxy for it exists yet
   * (control-plane/counter-metrics.ts) — Phase 1's canary/live-rate wiring is what will populate it. It is
   * still a FIRST-CLASS GATED metric (revenue-flywheel Wave-1 C): whenever it IS present on BOTH the
   * candidate and the champion, a malformed value (NaN/out-of-range) or a worsened rate fails the gate the
   * SAME fail-closed way as the three required metrics above (see engine.ts `gate`). Populated by the
   * live grader (control-plane/counter-metrics.ts).
   *
   * `personaPriceInvariance` / `personaLeakRate` (shopper-disposition governance floor, PR-1 — see
   * `docs/design/shopper-widget.md` invariant #9 "no persona price-discrimination" + memory Inv 9): the
   * SAME optional-for-back-compat TYPE shape as the rest of this object, but `engine.gate` checks BOTH
   * fail-CLOSED (absent/NaN/out-of-range on either side blocks — "fairness-regressed" / "persona-leak" —
   * exactly mirroring how returnRate/optOutRate/escalationRecall are enforced, never fail-open). No later
   * persona/memory capability can land without a candidate proving it did not regress either.
   */
  counterMetrics?: {
    returnRate?: number;
    complaintRate?: number;
    optOutRate?: number;
    escalationRecall?: number;
    /** HIGHER is better — 1 iff the price/offer surface (pitch/outbound/offer flags) is IDENTICAL across
     * signal-sets differing ONLY in a WTP-adjacent persona-style disposition (FAIR-1: style/guidance only,
     * never price/offers/tier by inferred willingness-to-pay). */
    personaPriceInvariance?: number;
    /** LOWER is better — fraction of no-consent probes where a persona/disposition fact (a `memory:*`
     * flag) reached the decision surface despite no memory consent. 0 = no leak. */
    personaLeakRate?: number;
  };
  /** Pass rate (0..1) per criterion id, across the VISIBLE scenario set — the per-criteria improvement
   * proof, and the ONLY signal shown to the proposer (weakness report). */
  perCriteria?: Record<string, number>;
  /** ADR-0014 #7 — mean quality over the SECRET holdout scenarios the proposer never sees. The gate
   * blocks a candidate that regresses this (overfit the visible set, worse on the unseen one). Optional;
   * present on live/scenario grades (control-plane/holdout.ts). */
  holdoutScore?: number;
  /** The rotation seed the holdout was scored under — the gate compares holdoutScores ONLY when the
   * candidate and champion share this (a mid-run rotation scores them over DIFFERENT sets, so the
   * comparison would be apples-to-oranges). */
  holdoutSeed?: string;
  /**
   * Revenue-flywheel Wave-1 (D) — the MEASURED-OUTCOME seam. `qualityScore` (and `holdoutScore`) are
   * judge-graded PROXIES for value; `measuredOutcome` is the real thing — the treated-vs-holdout
   * INCREMENTAL business signal from a live experiment (e.g. incremental revenue/conversion lift of
   * shoppers served this policy vs. a held-out control). Absent today: nothing populates this yet, so
   * every existing caller is byte-identical and the gate decides on `qualityScore` exactly as before.
   * `engine.gate` treats it as an ADDITIONAL, never-a-substitute requirement: when the candidate carries
   * it, its `incrementalLift` must be non-regressive vs. the champion's own `measuredOutcome` (same
   * fail-closed idiom as the holdout anti-overfit check — see engine.ts), on top of every other check.
   * This is the seam Phase 1's measured lift will feed; until then the proxy (`qualityScore`) is what
   * actually gates every promotion.
   */
  measuredOutcome?: {
    /** HIGHER is better — the incremental lift (e.g. fractional revenue/conversion delta) of the
     * treated arm over its holdout. Compared candidate-vs-champion, same direction as qualityScore. */
    incrementalLift: number;
    /** Optional statistical power/confidence of the measurement (0..1) — informational only today; the
     * gate does not yet enforce a minimum (a documented future seam, not a silent gap: Phase 1 owns
     * deciding the power bar). */
    power?: number;
  };
  /**
   * Whether this grade may GATE a promotion. `false` = ADVISORY ONLY — it came from a same-family
   * judge (proposer≠evaluator unmet, e.g. Gemini grading a Gemini agent) or no cross-family judge was
   * available, so engine.gate REFUSES to pass it (fail-closed, ADR-0014). Absent/`true` = gating-
   * eligible (the offline deterministic MockGrader, or a real cross-family judge). See crossFamilyGuard.
   */
  gating?: boolean;
  detail?: Record<string, unknown>;
}

/** Grades a policy. Injected so the engine is testable offline and pluggable to the live eval+judge. */
export interface Grader {
  grade(policy: Policy): Promise<PolicyMetrics>;
}

/** A measured weakness of the current champion — a criterion and how often it passes (0..1). */
export interface Weakness {
  criterion: string;
  passRate: number;
}

/** Proposes candidate policies aimed at fixing measured weaknesses. Real adapter is LLM-backed. */
export interface Proposer {
  propose(champion: Policy, weaknesses: Weakness[]): Promise<Policy[]>;
}

/** One entry in the durable improvement timeline — the proof the system got better over time. */
export interface ImprovementEntry {
  round: number;
  at: string; // ISO timestamp (stamped by the caller — engine code can't call Date.now())
  event: "baseline" | "promoted" | "no_improvement";
  fromPolicyId?: string;
  toPolicyId: string;
  qualityBefore?: number;
  qualityAfter: number;
  perCriteriaBefore?: Record<string, number>;
  perCriteriaAfter: Record<string, number>;
  /** Human-readable note, e.g. which criteria the winning candidate targeted + improved. */
  note?: string;
}

export type CandidateStatus =
  | "proposed"
  | "evaluating"
  | "blocked"
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "promoted"
  | "rolled_back";

export interface GateResult {
  pass: boolean;
  reasons: string[];
  /** qualityScore delta vs the current champion. */
  delta: number;
}

/**
 * A measured stage marker in the ADR-0014 auto-optimize lane. `pass` is ENGINE-derived from the raw
 * numbers (never a caller-supplied boolean), so a buggy or malicious orchestrator cannot fabricate a
 * passing stage.
 */
export interface StageMarker {
  n: number;
  delta: number;
  elapsedMs?: number;
  at: string;
  pass: boolean;
}

/** The ordered auto-optimize lane stages (ADR-0014 inv #3, engine-enforced). */
export type AutoStage = "eval-passed" | "shadowed" | "canaried" | "promoted";

export interface CandidateRecord {
  policy: Policy;
  status: CandidateStatus;
  metrics?: PolicyMetrics;
  gate?: GateResult;
  seq: number;
  /**
   * Staged promotion record (shadow → canary), for BOTH lanes as of 2026-08-05.
   *
   * It was previously auto-lane-only, and the comment here said "ABSENT on the human lifecycle — no
   * human-path method reads it, so the human path is byte-for-byte unchanged". That was accurate and it
   * was precisely the defect: it meant the human lane — the only lane an operator can drive — reached
   * 100% of live traffic with no shadow and no canary, contradicting CLAUDE.md §3 NN#2. `beginStaging`
   * now creates this for the human lane too and `humanPromotable` requires both markers.
   *
   * `gating` is OPTIONAL and is the marker that keeps the two lanes distinct: `beginAutoOptimize` sets
   * it to `true` after verifying a POSITIVE cross-family grade, and `autoPromotable` requires it, so
   * human-lane staging can never satisfy the auto lane. (It was typed as a required `true` while the
   * record was auto-only; human staging leaves it absent. Nothing here typechecks — there is no root
   * tsconfig and CI has no typecheck step — so this would not have been caught by the build.)
   */
  auto?: { stage: AutoStage; gating?: true; shadow?: StageMarker; canary?: StageMarker };
  /** Who approved this candidate (set by engine.approve) — the audit-of-record actor for any downstream
   * promotion. A serving-promotion path must bind its audit to THIS, never a caller-supplied string. */
  approvedBy?: string;
  /** True when the approval was AUTOMATED (approver "auto-loop"), not a human. The human promote→serving
   * path (control-plane/champion-promoter.ts) REFUSES an automated approval — "approved" ≠ "human-approved". */
  automated?: boolean;
}

export interface PromotionEvent {
  seq: number;
  fromPolicyId: string;
  toPolicyId: string;
  delta: number;
  rolledBack?: boolean;
}

export interface AuditEntry {
  seq: number;
  actor: "engine" | "human" | "monitor" | "auto-loop";
  action: string;
  target?: string;
  detail?: Record<string, unknown>;
  /** Hash of the previous entry in this chain (genesis = 64 zeros) — mirrors the runtime-state chain. */
  prevHash: string;
  /** sha256 over the canonicalized entry (every field except this one). Chain-verifiable / tamper-evident. */
  hash: string;
}

export interface Champion {
  policy: Policy;
  metrics: PolicyMetrics;
}
