import type { FastifyInstance } from "fastify";
import { requirePermission } from "@palup/identity-shopify";
import {
  PRIMARY_GOAL_KINDS,
  type PrimaryGoalKind,
  type PrimaryGoalSetInput,
  type PrimaryGoalStore,
  type RuntimeStatePort,
} from "@palup/platform-ports";
import { readHomeSummary } from "../home/read-model.js";

// W2 Task 4: the Revenue Home routes. `GET /home/summary` is `console.view` (every role — the
// scoreboard is the whole point of the console); `PUT /home/goal` is `settings.edit` (admin+owner,
// decision D4 — conservative least-privilege for agent-orienting config; the goal never authorizes
// an action, W4 rules + the W1 loop do). `ctx` is derived from `req.principal.merchantId` ONLY —
// same tenant-isolation guarantee as every other route in this package. `PUT` validates shape BEFORE
// the store is touched (the rules.ts precedent), and auditing is the STORE's own obligation
// (`PrimaryGoalStore.set` audits `goal.changed` internally) — this route just calls it.

export interface HomeRoutesDeps {
  state: RuntimeStatePort;
  goalStore: PrimaryGoalStore;
}

function validateGoalBody(body: unknown): { ok: true; value: PrimaryGoalSetInput } | { ok: false; reason: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, reason: "body must be an object" };
  }
  const { kind, note } = body as Record<string, unknown>;
  if (typeof kind !== "string" || !(PRIMARY_GOAL_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, reason: `kind must be one of: ${PRIMARY_GOAL_KINDS.join(", ")}` };
  }
  if (note !== undefined && typeof note !== "string") {
    return { ok: false, reason: "note must be a string" };
  }
  const value: PrimaryGoalSetInput = { kind: kind as PrimaryGoalKind };
  if (note !== undefined) value.note = note as string;
  return { ok: true, value };
}

export function registerHomeRoutes(app: FastifyInstance, deps: HomeRoutesDeps): void {
  app.get("/home/summary", { preHandler: requirePermission("console.view") }, async (req) => {
    const principal = req.principal!; // set by the enclosing requireMerchant preHandler
    return readHomeSummary(deps.state, deps.goalStore, principal.merchantId);
  });

  app.put<{ Body: unknown }>("/home/goal", { preHandler: requirePermission("settings.edit") }, async (req, reply) => {
    const principal = req.principal!;
    const validated = validateGoalBody(req.body);
    if (!validated.ok) {
      return reply.code(400).send({ error: "invalid goal", reason: validated.reason });
    }
    const goal = await deps.goalStore.set({ tenantId: principal.merchantId }, validated.value, principal.userId);
    return { goal };
  });
}
