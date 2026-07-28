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
  detail?: Record<string, unknown>;
}

/** Grades a policy. Injected so the engine is testable offline and pluggable to the live eval+judge. */
export interface Grader {
  grade(policy: Policy): Promise<PolicyMetrics>;
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
  actor: "engine" | "human" | "monitor";
  action: string;
  target?: string;
  detail?: Record<string, unknown>;
}

export interface Champion {
  policy: Policy;
  metrics: PolicyMetrics;
}
