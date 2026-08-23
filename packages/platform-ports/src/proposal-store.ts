// Proposal domain model + ProposalStore port (Approval Center's W1 contract; E1 engine-core). Lives
// here (not in `@palup/agent-runtime`) for the same reason `MerchantRegistryPort` lives here: a
// Postgres-backed adapter (`PostgresProposalStore`, `@palup/state-postgres`) must be able to import
// the port/types WITHOUT creating a package cycle with `@palup/agent-runtime` (which already depends
// on `@palup/state-postgres` for the shared kill registry — `kill.ts`). `@palup/agent-runtime`
// RE-EXPORTS everything below from its own `src/index.ts` so existing `@palup/agent-runtime` imports
// keep resolving unchanged; `classify.ts`/`loop.ts` (which stay in `agent-runtime` — they are the
// engine LOOP, not the port) import these types straight from `@palup/platform-ports`.
//
// Pin these signatures exactly; do not change them without updating every consumer: W1 (Approval
// Center, imports `ProposalStore`/`Proposal`), Minimal W4 (`RulesProvider` in `agent-runtime/classify.ts`
// implements against `ProposalCategory`), and the Win-back agent (calls `proposeOrExecute` with an
// `Executor`, `agent-runtime/loop.ts`).

import type { RuntimeStateCtx, RuntimeStatePort } from "./runtime-state-port.js";

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

// --- ProposalStore: the durable, tenant-scoped home for `Proposal` rows -----------------------------
//
// `transition` is the ONLY mutation path after `create`: it takes the caller's last-seen `version`
// and throws `VersionConflictError` if the stored row has moved on — optimistic locking so two
// concurrent decisions (e.g. an approve racing a kill-switch withdraw) can't silently clobber each
// other; the loser must re-read and retry.
//
// AUDIT (NN#5): every adapter (this in-memory one, `PostgresProposalStore`) is SILENT — it writes no
// audit records itself. `agent-runtime/loop.ts` is the sole caller of `create`/`transition` and
// already calls `RuntimeStatePort.audit(...)` around every one of them; an adapter-internal audit
// would be a second, silently-duplicated record on the hash-chained log, and — worse — an
// adapter-visible ASYMMETRY if one adapter did it and another didn't. So audit is the caller's job,
// consistently, for every adapter.

const COLLECTION = "proposal";

/** Thrown by `transition` when the caller's `expectedVersion` no longer matches the stored row —
 * someone else (or a prior call) already moved this proposal on. The caller must re-`get` and retry
 * with the fresh version, never blind-overwrite. */
export class VersionConflictError extends Error {
  constructor(
    public readonly id: string,
    public readonly expectedVersion: number,
    public readonly actualVersion: number,
  ) {
    super(`proposal ${id}: version conflict (expected ${expectedVersion}, actual ${actualVersion})`);
    this.name = "VersionConflictError";
  }
}

/** Thrown by `transition` when there is no row at all to transition. */
export class ProposalNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`proposal ${id}: not found`);
    this.name = "ProposalNotFoundError";
  }
}

export interface ProposalListFilter {
  status?: ProposalStatus;
  category?: ProposalCategory;
}

export interface ProposalListResult {
  items: Proposal[];
}

/** A patch applied by `transition`. `version` is set by the store (current+1); never pass it here. */
export type ProposalTransitionPatch = Partial<Omit<Proposal, "id" | "tenantId" | "version">>;

export interface ProposalStore {
  /** Persist a brand-new proposal (tenant taken from `proposal.tenantId`). Overwrites nothing —
   * callers must supply a fresh `id`. */
  create(proposal: Proposal): Promise<Proposal>;
  /** Tenant-scoped read by id; `null` if absent OR belongs to another tenant. */
  get(ctx: RuntimeStateCtx, id: string): Promise<Proposal | null>;
  /** Tenant-scoped list, optionally filtered by `status`/`category` (AND semantics when both given). */
  list(ctx: RuntimeStateCtx, filter?: ProposalListFilter): Promise<ProposalListResult>;
  /** Optimistic-locked mutation: throws `VersionConflictError` if `expectedVersion` is stale,
   * `ProposalNotFoundError` if the row doesn't exist for this tenant. */
  transition(
    ctx: RuntimeStateCtx,
    id: string,
    expectedVersion: number,
    patch: ProposalTransitionPatch,
  ): Promise<Proposal>;
}

/** PATTERN: mirrors `outcome-ledger-store.ts` / `cost-cap-registry.ts` — a registry over the shared
 *  `RuntimeStatePort`, no new port surface. One KV collection ("proposal"), keyed by `proposal.id`,
 *  tenant-scoped by `RuntimeStateCtx`. */
export class InMemoryProposalStore implements ProposalStore {
  constructor(private readonly store: RuntimeStatePort) {}

  async create(proposal: Proposal): Promise<Proposal> {
    const ctx: RuntimeStateCtx = { tenantId: proposal.tenantId };
    return this.store.tx(ctx, async (t) => {
      await t.put(COLLECTION, proposal.id, proposal);
      return proposal;
    });
  }

  async get(ctx: RuntimeStateCtx, id: string): Promise<Proposal | null> {
    return this.store.get<Proposal>(ctx, COLLECTION, id);
  }

  async list(ctx: RuntimeStateCtx, filter?: ProposalListFilter): Promise<ProposalListResult> {
    const rows = await this.store.list<Proposal>(ctx, COLLECTION);
    const items = rows
      .map((r) => r.value)
      .filter((p) => (filter?.status ? p.status === filter.status : true))
      .filter((p) => (filter?.category ? p.category === filter.category : true));
    return { items };
  }

  async transition(
    ctx: RuntimeStateCtx,
    id: string,
    expectedVersion: number,
    patch: ProposalTransitionPatch,
  ): Promise<Proposal> {
    return this.store.tx(ctx, async (t) => {
      const current = await t.get<Proposal>(COLLECTION, id);
      if (!current) throw new ProposalNotFoundError(id);
      if (current.version !== expectedVersion) {
        throw new VersionConflictError(id, expectedVersion, current.version);
      }
      const next: Proposal = { ...current, ...patch, version: current.version + 1 };
      await t.put(COLLECTION, id, next);
      return next;
    });
  }
}
