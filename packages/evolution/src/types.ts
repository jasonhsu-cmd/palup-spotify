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
  /** Counter-metrics that must NOT worsen (returns/complaints/opt-outs) — lower is better. */
  counterMetrics?: { returnRate?: number; complaintRate?: number };
  /** Pass rate (0..1) per criterion id, across the scenario set — the per-criteria improvement proof. */
  perCriteria?: Record<string, number>;
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

export interface CandidateRecord {
  policy: Policy;
  status: CandidateStatus;
  metrics?: PolicyMetrics;
  gate?: GateResult;
  seq: number;
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
