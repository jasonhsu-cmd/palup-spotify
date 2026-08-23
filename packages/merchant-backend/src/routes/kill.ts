import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { requirePermission } from "@palup/identity-shopify";
import type { MerchantRole, RuntimeStatePort } from "@palup/platform-ports";
import { killMerchant, merchantKillStatus, unkillMerchant } from "@palup/agent-runtime";

// W1-API Task 5: the merchant Kill Switch (governance non-negotiable #4 — "any agent, at any scope,
// can be halted instantly"). Thin route layer over `@palup/agent-runtime`'s tenant-scoped wrappers
// (`kill.ts`), which themselves reuse the SAME shared `state-postgres` kill registry the serving
// widget-backend checks — arming/disarming here propagates to every serving instance, and audits
// atomically inside `armKill`/`disarmKill` (NN #5), not re-done here.
//
// `ctx` is derived from `req.principal.merchantId` ONLY (never a query/body param), same tenant
// isolation guarantee as every other route in this package — a caller can only halt/resume their OWN
// tenant, never another merchant's.

export interface KillRoutesDeps {
  state: RuntimeStatePort;
}

interface KillBody {
  reason?: string;
}

// Halting autonomy (`agent.operate`, every operator+ role) is a smaller, more-reversible action than
// RESUMING it (`unkill`) — an operator who mis-armed a global/tenant kill can always re-arm it, but an
// unattended resume re-enables live autonomous execution. `DEFAULT_ROLE_PERMISSIONS`
// (merchant-identity-port.ts) has no dedicated "resume_autonomy" permission yet, and reusing an
// unrelated manager+ permission (e.g. `rules.edit`) would tie this route's gate to a permission whose
// NAME has nothing to do with resuming autonomy — a future edit to who gets `rules.edit` could loosen
// this route by accident. Instead: a small, self-contained role-rank check scoped to this route,
// mirroring the SAME additive ladder (`viewer < operator < manager < admin < owner`) the permission
// ladder itself is built on, so "manager and above" stays an explicit, correct, single-purpose gate.
const ROLE_RANK: Readonly<Record<MerchantRole, number>> = {
  viewer: 0,
  operator: 1,
  manager: 2,
  admin: 3,
  owner: 4,
};

function requireRole(minRole: MerchantRole): preHandlerHookHandler {
  return async (req, reply) => {
    const p = req.principal;
    // fail-closed if mounted standalone (idempotent with the enclosing `requireMerchant` preHandler,
    // same defensive pattern `requirePermission` in identity-shopify/fastify-plugin.ts follows).
    if (!p || p.kind !== "merchant_user") {
      await reply.code(401).send({ error: "unauthenticated" });
      return;
    }
    if (ROLE_RANK[p.role] < ROLE_RANK[minRole]) {
      await reply.code(403).send({ error: "forbidden", minRole });
      return;
    }
  };
}

export function registerKillRoutes(app: FastifyInstance, deps: KillRoutesDeps): void {
  app.get("/kill", { preHandler: requirePermission("console.view") }, async (req) => {
    const principal = req.principal!;
    const ctx = { tenantId: principal.merchantId };
    const entry = await merchantKillStatus(deps.state, ctx);
    return { killed: entry !== null };
  });

  app.post<{ Body: KillBody }>("/kill", { preHandler: requirePermission("agent.operate") }, async (req, reply) => {
    const principal = req.principal!;
    const ctx = { tenantId: principal.merchantId };
    const reason = req.body?.reason?.trim();
    if (!reason) {
      return reply.code(400).send({ error: "reason is required" });
    }
    await killMerchant(deps.state, ctx, reason);
    return { killed: true };
  });

  // Resuming autonomy — gated at manager+ (see `requireRole` comment above), not `agent.operate`.
  app.post("/unkill", { preHandler: requireRole("manager") }, async (req) => {
    const principal = req.principal!;
    const ctx = { tenantId: principal.merchantId };
    await unkillMerchant(deps.state, ctx);
    return { killed: false };
  });
}
