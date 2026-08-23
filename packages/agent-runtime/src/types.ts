// Proposal domain model — the contract W1 (Approval Center), Minimal W4 (Rules), and the
// Win-back agent import. Pin these exactly; do not change signatures without updating all
// three consumers. See docs/superpowers/plans/2026-08-23-E1-engine-core.md "Interfaces".

export type ProposalCategory =
  | "discount"
  | "ad_spend"
  | "refund"
  | "campaign"
  | "autonomy_scope"
  | "subscription";

export type ProposalStatus =
  | "pending"
  | "approved"
  | "executing"
  | "executed"
  | "execution_failed"
  | "rejected"
  | "expired"
  | "withdrawn"
  | "killed";

export interface AgentAction {
  type: string; // e.g. "send_campaign" | "issue_discount" | "issue_refund"
  params: Record<string, unknown>;
  irreversible?: boolean; // e.g. an email send
  blastRadius?: number; // e.g. recipient count — drives the mass-send floor
}

export interface BoundaryReason {
  rule: string;
  detail: string;
} // traceable to a HITL rule

export interface ReversalPlan {
  reversible: boolean;
  plan: string;
} // plan = the way back, or honest containment

export interface Proposal {
  id: string;
  tenantId: string;
  agentId: string;
  agentType: string; // RUNTIME_AGENT_TYPE-compatible
  action: AgentAction;
  category: ProposalCategory;
  rationale: string;
  boundaryReasons: BoundaryReason[];
  estimatedImpact?: { amountUsd?: number; reach?: number; note?: string };
  reversalPlan: ReversalPlan; // REQUIRED — creation throws without it
  preconditions: Record<string, unknown>; // re-validated at approve time
  status: ProposalStatus;
  version: number; // optimistic lock
  createdAt: string; // ISO; supplied by caller (no Date.now in pure code)
  expiresAt: string; // ISO; category-derived TTL
  decidedBy?: string;
  decidedAt?: string;
  decisionNote?: string;
  executionId?: string; // idempotency key
  executedAt?: string;
  executionResult?: { ok: boolean; detail: string };
}

const HOUR_MS = 3600_000;

// TTL-by-category (constant): discount|ad_spend 24h, campaign|refund 72h,
// subscription|autonomy_scope 7d (from spec W1: 72h default, category-tuned).
const CATEGORY_TTL_MS: Record<ProposalCategory, number> = {
  discount: 24 * HOUR_MS,
  ad_spend: 24 * HOUR_MS,
  campaign: 72 * HOUR_MS,
  refund: 72 * HOUR_MS,
  subscription: 7 * 24 * HOUR_MS,
  autonomy_scope: 7 * 24 * HOUR_MS,
};

export function ttlForCategory(c: ProposalCategory): number {
  return CATEGORY_TTL_MS[c];
}
