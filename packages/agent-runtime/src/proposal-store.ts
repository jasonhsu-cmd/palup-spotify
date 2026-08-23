// ProposalStore — the durable, tenant-scoped home for `Proposal` rows (Approval Center's W1
// contract). PATTERN: mirrors `outcome-ledger-store.ts` / `cost-cap-registry.ts` — a registry over
// the shared `RuntimeStatePort`, no new port surface. One KV collection ("proposal"), keyed by
// `proposal.id`, tenant-scoped by `RuntimeStateCtx`. Read + write + audit commit atomically
// (governance non-negotiable #5 — "no silent actions").
//
// `transition` is the ONLY mutation path after `create`: it takes the caller's last-seen `version`
// and throws `VersionConflictError` if the stored row has moved on — optimistic locking so two
// concurrent decisions (e.g. an approve racing a kill-switch withdraw) can't silently clobber each
// other; the loser must re-read and retry.

import type { RuntimeStateCtx, RuntimeStatePort } from "@palup/platform-ports";
import type { Proposal, ProposalCategory, ProposalStatus } from "./types.js";

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

export class InMemoryProposalStore implements ProposalStore {
  constructor(private readonly store: RuntimeStatePort) {}

  async create(proposal: Proposal): Promise<Proposal> {
    const ctx: RuntimeStateCtx = { tenantId: proposal.tenantId };
    return this.store.tx(ctx, async (t) => {
      await t.put(COLLECTION, proposal.id, proposal);
      await t.audit({
        actor: proposal.agentId,
        action: "proposal.create",
        input: { id: proposal.id, agentType: proposal.agentType, category: proposal.category, action: proposal.action },
        decision: { status: proposal.status },
        reversalPath: proposal.reversalPlan.plan,
      });
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
      await t.audit({
        actor: patch.decidedBy ?? "system",
        action: "proposal.transition",
        input: { id, expectedVersion, patch },
        decision: { status: next.status, version: next.version },
        reversalPath: next.reversalPlan.plan,
      });
      return next;
    });
  }
}
