import type { FastifyInstance } from "fastify";
import { requirePermission } from "@palup/identity-shopify";

/** Registered inside server.ts's authenticated merchant-plane context, so every route here already
 *  runs behind F2's `requireMerchant` preHandler (401 fail-closed) before it's reached. */
export function registerMeRoutes(app: FastifyInstance): void {
  app.get("/me", async (req) => {
    const p = req.principal!; // set by the enclosing requireMerchant preHandler
    return { merchantId: p.merchantId, userId: p.userId, role: p.role, authLevel: p.authLevel };
  });

  // TODO(W1): remove /_probe/money once real money routes exist — this exists only to prove the
  // requireMerchant -> requirePermission("approve_money") RBAC chain end-to-end (401/403/200).
  app.get("/_probe/money", { preHandler: requirePermission("approve_money") }, async () => ({ ok: true }));
}
