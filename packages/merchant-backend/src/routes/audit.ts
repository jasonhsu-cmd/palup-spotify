import type { FastifyInstance } from "fastify";
import { requirePermission } from "@palup/identity-shopify";
import type { AuditRecord, RuntimeStatePort } from "@palup/platform-ports";

// W1-API Task 6: `GET /audit` — the read surface over the tenant's immutable, hash-chained Audit Log
// (governance non-negotiable #5). `ctx` is derived from `req.principal.merchantId` ONLY (never a
// query/body param), same tenant-isolation guarantee every other route in this package follows —
// `RuntimeStatePort.readAudit` itself only ever reads the caller's own tenant partition, so there is
// no cross-tenant leak surface here to test against (unlike `/approvals/:id`, there is no
// caller-supplied id that could resolve to another tenant's row).
//
// PII/secret safety — STRUCTURAL allowlist (coordinator review): `AuditInput.input`/`.decision` are
// typed `unknown` and passed straight through from ~roughly 50 write sites across the codebase.
// Every one of those write sites redacts today, per `RuntimeStatePort`'s own contract ("Callers MUST
// redact PII before passing input", runtime-state-port.ts) — but a customer-facing READ surface must
// not depend on ALL of them staying correct forever; one future write-site regression would leak
// straight through an unredacted pass-through undetected. `toSafeEntry` below maps every
// `AuditRecord` to a FIXED response DTO containing only the safe, merchant-meaningful fields —
// `seq`, `at`, `actor`, `action`, `reversalPath`, `hash` — and NEVER the raw `input`/`decision` blobs
// (or `prevHash`, which is chain-internal, not merchant-facing). This makes the read surface safe
// by construction regardless of write-site behavior.

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

/** The merchant-safe audit entry shape returned by `GET /audit`. Deliberately excludes `input`,
 *  `decision`, and `prevHash` — see the module header for why. */
export interface SafeAuditEntry {
  seq: number;
  at: string;
  actor: string;
  action: string;
  reversalPath?: string;
  hash: string;
}

function toSafeEntry(record: AuditRecord): SafeAuditEntry {
  const entry: SafeAuditEntry = {
    seq: record.seq,
    at: record.at,
    actor: record.actor,
    action: record.action,
    hash: record.hash,
  };
  if (record.reversalPath !== undefined) entry.reversalPath = record.reversalPath;
  return entry;
}

export function registerAuditRoutes(app: FastifyInstance, deps: AuditRoutesDeps): void {
  app.get<{ Querystring: AuditListQuery }>(
    "/audit",
    { preHandler: requirePermission("console.view") },
    async (req) => {
      const principal = req.principal!; // set by the enclosing requireMerchant preHandler
      const ctx = { tenantId: principal.merchantId };
      const records = await deps.state.readAudit(ctx);
      return { items: records.map(toSafeEntry) };
    },
  );
}
