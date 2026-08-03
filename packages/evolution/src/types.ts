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
   * regresses these (ADR-0014 #5). returnRate/complaintRate/optOutRate are lower-is-better; escalationRecall
   * is HIGHER-is-better (recall of required escalations). Populated by the live grader
   * (control-plane/counter-metrics.ts). Fields stay optional for back-compat; a follow-up makes the gate
   * fail CLOSED when they are absent (today engine.gate only checks return/complaint and treats absent as 0).
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
   * ADR-0014 T4 auto-optimize lane (engine-enforced stage completion). ABSENT on the human lifecycle —
   * no human-path method reads it, so the human path is byte-for-byte unchanged. `gating: true` records
   * that beginAutoOptimize verified a POSITIVE cross-family gating grade (the delta over engine.gate,
   * which passes gating===undefined). The stage advances ONLY in order and ONLY on an engine-derived
   * pass; the durable serving write refuses unless autoPromotable() re-derives ok from these markers.
   */
  auto?: { stage: AutoStage; gating: true; shadow?: StageMarker; canary?: StageMarker };
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
