import type { FastifyInstance } from "fastify";
import { requirePermission } from "@palup/identity-shopify";
import type { ProposalCategory, ProposalStatus, ProposalStore } from "@palup/platform-ports";

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
}
