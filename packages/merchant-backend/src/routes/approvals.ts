import type { FastifyInstance } from "fastify";
import { requirePermission } from "@palup/identity-shopify";
import type { CampaignCommsPort, MerchantRulesStore, ProposalCategory, ProposalStatus, ProposalStore, RuntimeStatePort } from "@palup/platform-ports";
import {
  KillSwitchError,
  ProposalNotFoundError,
  VersionConflictError,
  createRulesProvider,
  executeApproved,
  rejectProposal,
  type EngineDeps,
  type Executor,
  type PreconditionValidator,
} from "@palup/agent-runtime";
import { buildEngineDeps } from "../engine-wiring.js";

// W1-API's Approval Center read surface: `GET /approvals` (list, tenant-scoped, optional
// status/category filter) + `GET /approvals/:id` (detail). Both registered inside server.ts's
// authenticated `merchantPlane` context (F3), so every call already ran `requireMerchant` (401
// fail-closed) before reaching either handler here; `requirePermission("console.view")`
// additionally gates on RBAC (every `MerchantRole` — including the floor role `viewer` — carries
// `console.view` per `platform-ports/merchant-identity-port.ts`'s `DEFAULT_ROLE_PERMISSIONS`, so
// this permission never actually 403s a real role; it exists so a future, narrower permission model
// can tighten it without touching call sites).
//
// `ctx` is derived from `req.principal.merchantId` ONLY — never a query/body param — so a caller can
// never list or read another tenant's proposals. `ProposalStore.get`'s own contract returns `null`
// for a row that belongs to another tenant (not just a missing id), so the cross-tenant case 404s
// identically to a truly-missing id — never a 403 that would leak "this id exists, just not yours".

const PROPOSAL_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "approved",
  "executing",
  "executed",
  "execution_failed",
  "rejected",
  "expired",
  "withdrawn",
  "killed",
]);

const PROPOSAL_CATEGORIES: ReadonlySet<string> = new Set([
  "discount",
  "ad_spend",
  "refund",
  "campaign",
  "autonomy_scope",
  "subscription",
]);

export interface ApprovalsRoutesDeps {
  proposalStore: ProposalStore;
  /** Needed by approve/reject (T3/T4): `EngineDeps.state` for `executeApproved`/`rejectProposal`'s
   *  kill-switch check + audit trail. */
  state: RuntimeStatePort;
  /** Needed by approve (T3): `buildEngineDeps` resolves the proposal's category to a validator via
   *  `createRulesProvider(rulesStore)`, mirroring `internal-winback.ts`'s composition. */
  rulesStore: MerchantRulesStore;
  /** Needed by approve (T3): `buildEngineDeps` resolves the proposal's action type to an executor
   *  (e.g. `send_campaign` -> `campaignExecutor(comms)`). */
  comms: CampaignCommsPort;
}

interface ApprovalsListQuery {
  status?: string;
  category?: string;
  /** Accepted for forward API compatibility; `ProposalStore.list`/`ProposalListFilter` has no
   *  pagination surface yet (both the in-memory and Postgres adapters return the full tenant-scoped
   *  set), so this is presently a no-op. TODO(pagination): wire once the store grows a cursor. */
  cursor?: string;
}

interface ApprovalsDetailParams {
  id: string;
}

interface ApproveBody {
  version: number;
  /** Accepted for forward API compatibility with the spec's `{version, note?}` body — neither
   *  `executeApproved` nor `Proposal` currently has a decision-note field for the APPROVE path
   *  (only `rejectProposal`/`withdrawProposal` write `decisionNote`), so this is presently a no-op.
   *  TODO: wire once `executeApproved` grows a note param. */
  note?: string;
}

interface RejectBody {
  reason: string;
}

/** A poison `Executor`/`PreconditionValidator` pair for the reject path: `rejectProposal`
 *  (agent-runtime/loop.ts) only ever touches `deps.store`/`deps.state` — it never calls `executor`
 *  or `validate` (those exist solely to satisfy `EngineDeps`'s shape). Wiring real ones here would
 *  either require resolving an executor/validator for a proposal we are about to REJECT (pointless),
 *  or silently mask a future change that made `rejectProposal` execute something it shouldn't. These
 *  throw loudly instead, so that regression fails a test immediately rather than shipping quiet. */
const poisonExecutor: Executor = async () => {
  throw new Error("reject route: Executor must never be invoked — rejectProposal does not execute");
};
const poisonValidate: PreconditionValidator = async () => {
  throw new Error("reject route: PreconditionValidator must never be invoked — rejectProposal does not validate");
};

export function registerApprovalsRoutes(app: FastifyInstance, deps: ApprovalsRoutesDeps): void {
  app.get<{ Querystring: ApprovalsListQuery }>(
    "/approvals",
    { preHandler: requirePermission("console.view") },
    async (req, reply) => {
      const principal = req.principal!; // set by the enclosing requireMerchant preHandler
      const ctx = { tenantId: principal.merchantId };
      const { status, category } = req.query;

      if (status !== undefined && !PROPOSAL_STATUSES.has(status)) {
        return reply.code(400).send({ error: "invalid status" });
      }
      if (category !== undefined && !PROPOSAL_CATEGORIES.has(category)) {
        return reply.code(400).send({ error: "invalid category" });
      }

      const result = await deps.proposalStore.list(ctx, {
        status: status as ProposalStatus | undefined,
        category: category as ProposalCategory | undefined,
      });
      return { items: result.items };
    },
  );

  app.get<{ Params: ApprovalsDetailParams }>(
    "/approvals/:id",
    { preHandler: requirePermission("console.view") },
    async (req, reply) => {
      const principal = req.principal!;
      const ctx = { tenantId: principal.merchantId };
      const proposal = await deps.proposalStore.get(ctx, req.params.id);
      if (!proposal) return reply.code(404).send({ error: "not found" });
      return proposal;
    },
  );

  // T3: POST /approvals/:id/approve — `approve_money` (owner+admin only, DEFAULT_ROLE_PERMISSIONS)
  // gates this: a real 403 for viewer/operator/manager, unlike the read routes above. `ctx` is
  // derived from `req.principal.merchantId` ONLY, same tenant-isolation guarantee as GET — a caller
  // can never approve another tenant's proposal (the `get` below 404s identically for missing vs.
  // cross-tenant, never leaking existence via a 403).
  app.post<{ Params: ApprovalsDetailParams; Body: ApproveBody }>(
    "/approvals/:id/approve",
    { preHandler: requirePermission("approve_money") },
    async (req, reply) => {
      const principal = req.principal!;
      const ctx = { tenantId: principal.merchantId };
      const { id } = req.params;
      const { version } = req.body;

      const proposal = await deps.proposalStore.get(ctx, id);
      if (!proposal) return reply.code(404).send({ error: "not found" });

      // Guard the caller's `version` against the loaded proposal's version BEFORE calling
      // `executeApproved` — gives a clean 409 (with the current version, so the UI can re-fetch and
      // retry) without ever reaching the kill-switch check or the executor for a stale request.
      if (version !== proposal.version) {
        return reply.code(409).send({ error: "version conflict", currentVersion: proposal.version });
      }

      const now = new Date().toISOString();
      const engineDeps = buildEngineDeps({
        store: deps.proposalStore,
        state: deps.state,
        rules: createRulesProvider(deps.rulesStore),
        actionType: proposal.action.type,
        category: proposal.category,
        comms: deps.comms,
      });

      try {
        const updated = await executeApproved(ctx, id, principal.userId, now, engineDeps);
        return updated;
      } catch (e) {
        // Belt-and-suspenders: the pre-check above already catches the common race, but
        // `executeApproved` re-checks the version itself inside its own `transition` call, so a
        // genuine concurrent race (two approvals in flight) still lands here, not as a 500.
        if (e instanceof VersionConflictError) {
          return reply.code(409).send({ error: "version conflict", currentVersion: e.actualVersion });
        }
        if (e instanceof KillSwitchError) {
          return reply.code(423).send({ error: "kill switch armed", reason: e.entry.reason });
        }
        if (e instanceof ProposalNotFoundError) {
          return reply.code(404).send({ error: "not found" });
        }
        // Found via reject.test.ts's reject-then-approve case: `executeApproved`'s own
        // TERMINAL_BLOCKING_STATUSES guard (already rejected/withdrawn/expired/killed) throws a
        // plain `Error`, not a typed one — map it to a clean 409 rather than an unhandled 500 (a
        // settled decision must fail the retry cleanly, never crash the request).
        if (e instanceof Error) {
          return reply.code(409).send({ error: e.message });
        }
        throw e;
      }
    },
  );

  // T4: POST /approvals/:id/reject — same `approve_money` gate as approve. `rejectProposal` never
  // executes (see the poison `EngineDeps` above), only transitions the proposal to `rejected` +
  // audits — so a later `executeApproved` on the same id fails cleanly (TERMINAL_BLOCKING_STATUSES).
  app.post<{ Params: ApprovalsDetailParams; Body: RejectBody }>(
    "/approvals/:id/reject",
    { preHandler: requirePermission("approve_money") },
    async (req, reply) => {
      const principal = req.principal!;
      const ctx = { tenantId: principal.merchantId };
      const { id } = req.params;
      const reason = req.body?.reason;

      if (!reason || !reason.trim()) {
        return reply.code(400).send({ error: "reason is required" });
      }

      const now = new Date().toISOString();
      const engineDeps: EngineDeps = {
        store: deps.proposalStore,
        state: deps.state,
        rules: createRulesProvider(deps.rulesStore),
        executor: poisonExecutor,
        validate: poisonValidate,
      };

      try {
        const updated = await rejectProposal(ctx, id, principal.userId, reason, now, engineDeps);
        return updated;
      } catch (e) {
        if (e instanceof ProposalNotFoundError) return reply.code(404).send({ error: "not found" });
        if (e instanceof VersionConflictError) return reply.code(409).send({ error: "version conflict" });
        // `rejectProposal`'s own terminal-state guard (e.g. already executed/rejected) throws a plain
        // `Error` — map it to a clean 409 rather than an unhandled 500 (spec: "rejecting a non-pending
        // proposal must fail cleanly").
        if (e instanceof Error) return reply.code(409).send({ error: e.message });
        throw e;
      }
    },
  );
}
