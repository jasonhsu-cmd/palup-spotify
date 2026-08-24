import type { FastifyInstance } from "fastify";
import { requirePermission } from "@palup/identity-shopify";
import type { AuditRecord, RuntimeStatePort } from "@palup/platform-ports";

// W2 Task 5: `GET /activity` — the merchant-facing "what did my agent do" feed (spec §9 W2), an
// ALLOWLIST read model over the tenant's audit log (D8). The audit log is the ONLY agent-activity
// source that exists (E1's loop.ts writes proposal.*/agent.action.* records; ADR-0006's richer
// event stream is not built) — so this feed is honest by construction: it can only show what was
// actually audited. Two disciplines carried over from routes/audit.ts:
//   • FIXED safe DTO — {seq, at, actor, action} only; never input/decision (typed `unknown`,
//     written by ~50 sites) and never prevHash/hash (chain-internal).
//   • `cursor` accepted but presently a no-op — `readAudit` has only `limit` (most-recent-N), so we
//     over-fetch and filter in-process. TODO(pagination): wire once the port grows a cursor.
// The ALLOWLIST (not a denylist) means new audit actions are EXCLUDED until deliberately added —
// a future write site can never accidentally leak an operational/config record into the feed.
// `goal.changed` is DELIBERATELY excluded from this feed — it has its own surface (the Home
// goal screen) — so a future reader must not add it here.

export interface ActivityRoutesDeps {
  state: RuntimeStatePort;
}

/** The audit actions that ARE merchant-visible agent activity. Exactly the slugs `agent-runtime/
 * src/loop.ts` writes (verified against loop.ts) — metric plumbing (arm_tally.accumulate,
 * outcome_ledger.append), config changes (rules.changed, goal.changed — they have their own
 * surfaces), and kill/identity records are deliberately absent. */
export const ACTIVITY_ACTIONS: ReadonlySet<string> = new Set([
  "agent.action.auto.intent",
  "agent.action.auto",
  "agent.action.failed",
  "proposal.created",
  "proposal.approved",
  "proposal.rejected",
  "proposal.executing",
  "proposal.executed",
  "proposal.execution_failed",
  "proposal.expired",
  "proposal.withdrawn",
  "proposal.revalidation_failed",
]);

/** The merchant-safe activity entry. Deliberately smaller than SafeAuditEntry (no hash — this is a
 * product feed, not a verification surface; the audit screen serves that). */
export interface ActivityEntry {
  seq: number;
  at: string;
  actor: string;
  action: string;
}

interface ActivityListQuery {
  cursor?: string;
}

/** Over-fetch bound: the most-recent N audit records scanned per request. Activity actions are a
 * subset, so the feed shows at most this many — a bounded, honest window, not full history. */
const AUDIT_OVERFETCH = 500;

function toActivityEntry(record: AuditRecord): ActivityEntry {
  return { seq: record.seq, at: record.at, actor: record.actor, action: record.action };
}

export function registerActivityRoutes(app: FastifyInstance, deps: ActivityRoutesDeps): void {
  app.get<{ Querystring: ActivityListQuery }>(
    "/activity",
    { preHandler: requirePermission("console.view") },
    async (req) => {
      const principal = req.principal!; // set by the enclosing requireMerchant preHandler
      const records = await deps.state.readAudit({ tenantId: principal.merchantId }, { limit: AUDIT_OVERFETCH });
      const items = records
        .filter((r) => ACTIVITY_ACTIONS.has(r.action))
        .map(toActivityEntry)
        .reverse(); // readAudit is oldest-first; the feed wants newest-first
      return { items };
    },
  );
}
