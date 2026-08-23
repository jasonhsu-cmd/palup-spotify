import type { FastifyInstance } from "fastify";
import { requirePermission } from "@palup/identity-shopify";
import type { RuntimeStatePort } from "@palup/platform-ports";

// W1-API Task 6: `GET /audit` — the read surface over the tenant's immutable, hash-chained Audit Log
// (governance non-negotiable #5). `ctx` is derived from `req.principal.merchantId` ONLY (never a
// query/body param), same tenant-isolation guarantee every other route in this package follows —
// `RuntimeStatePort.readAudit` itself only ever reads the caller's own tenant partition, so there is
// no cross-tenant leak surface here to test against (unlike `/approvals/:id`, there is no
// caller-supplied id that could resolve to another tenant's row).
//
// PII/secret safety: `AuditInput.input`/`.decision` are NOT redacted by this route — they are
// redacted at the WRITE side, per `RuntimeStatePort`'s own contract ("Callers MUST redact PII before
// passing input", runtime-state-port.ts). This route returns the committed `AuditRecord` exactly as
// written — `seq`, `at`, `actor`, `action`, `input`, `decision`, `reversalPath`, `prevHash`, `hash` —
// never a raw credential/secret field, because none of those ever exist on this port's own type.

export interface AuditRoutesDeps {
  state: RuntimeStatePort;
}

interface AuditListQuery {
  /** Accepted for forward API compatibility; `RuntimeStatePort.readAudit` has no cursor param (only
   *  `limit`, oldest-first with no offset), so this is presently a no-op — the same convention
   *  `approvals.ts`'s list route follows for its own not-yet-wired `cursor`. TODO(pagination): wire
   *  once the port grows a cursor. */
  cursor?: string;
}

export function registerAuditRoutes(app: FastifyInstance, deps: AuditRoutesDeps): void {
  app.get<{ Querystring: AuditListQuery }>(
    "/audit",
    { preHandler: requirePermission("console.view") },
    async (req) => {
      const principal = req.principal!; // set by the enclosing requireMerchant preHandler
      const ctx = { tenantId: principal.merchantId };
      const items = await deps.state.readAudit(ctx);
      return { items };
    },
  );
}
