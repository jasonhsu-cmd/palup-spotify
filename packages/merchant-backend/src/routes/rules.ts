import type { FastifyInstance } from "fastify";
import { requirePermission } from "@palup/identity-shopify";
import type { CategoryRuleEnvelope, MerchantRuleSet, MerchantRulesStore, ProposalCategory } from "@palup/platform-ports";

// Deferred W4-min Task 4: the merchant-facing `GET/PUT /rules` — lets the console read/edit the
// standing automation-rule envelope that `createRulesProvider` (agent-runtime) already reads at
// classify-time. `GET` is `console.view` (every role, including `viewer`, per
// `DEFAULT_ROLE_PERMISSIONS`); `PUT` is `rules.edit` (manager+ only — `MANAGER` is the first rung that
// grants it in `platform-ports/merchant-identity-port.ts`). `ctx` is derived from
// `req.principal.merchantId` ONLY (never a body/query param) — same tenant-isolation guarantee as every
// other route in this package.
//
// `PUT` never applies a raw, unvalidated body to `store.set`: a malformed shape (unknown category key,
// wrong field types) is rejected 400 BEFORE it reaches the store, so a bad console request can never
// write a garbage envelope for `createRulesProvider` to later read (and `PALUP_FLOORS`'s clamp is a
// SEPARATE, later safety net — this validation is about shape/type correctness, not the floor itself,
// which `set`'s caller — the engine loop, via `createRulesProvider` — clamps at read time).
//
// Auditing (NN#5) is NOT done here: `MerchantRulesStore.set`'s own contract (`merchant-rules-store.ts`)
// requires every implementer to audit internally (there is no single engine-loop call site that owns
// it, unlike `ProposalStore`), so both `InMemoryMerchantRulesStore` and `PostgresMerchantRulesStore`
// already write the `"rules.changed"` audit record as part of `set` — this route just calls it.

export interface RulesRoutesDeps {
  rulesStore: MerchantRulesStore;
}

const VALID_CATEGORIES: ReadonlySet<string> = new Set<ProposalCategory>([
  "discount",
  "ad_spend",
  "refund",
  "campaign",
  "autonomy_scope",
  "subscription",
]);

/** Structural validation of a `PUT /rules` body against `MerchantRuleSet`'s shape: every top-level key
 *  must be a known `ProposalCategory`, and every value must be a `CategoryRuleEnvelope` — a boolean
 *  `allowedAuto` plus optional numeric `maxPct`/`maxUsd`. Returns a human-readable reason on failure so
 *  the 400 response can say what was wrong, never a raw echo of the offending value. */
function validateRuleSetBody(body: unknown): { ok: true; value: MerchantRuleSet } | { ok: false; reason: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, reason: "body must be an object" };
  }
  const value: MerchantRuleSet = {};
  for (const [key, raw] of Object.entries(body as Record<string, unknown>)) {
    if (!VALID_CATEGORIES.has(key)) {
      return { ok: false, reason: `unknown category: ${key}` };
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ok: false, reason: `${key}: envelope must be an object` };
    }
    const env = raw as Record<string, unknown>;
    if (typeof env.allowedAuto !== "boolean") {
      return { ok: false, reason: `${key}: allowedAuto must be a boolean` };
    }
    if (env.maxPct !== undefined && typeof env.maxPct !== "number") {
      return { ok: false, reason: `${key}: maxPct must be a number` };
    }
    if (env.maxUsd !== undefined && typeof env.maxUsd !== "number") {
      return { ok: false, reason: `${key}: maxUsd must be a number` };
    }
    const entry: CategoryRuleEnvelope = { allowedAuto: env.allowedAuto };
    if (env.maxPct !== undefined) entry.maxPct = env.maxPct as number;
    if (env.maxUsd !== undefined) entry.maxUsd = env.maxUsd as number;
    value[key as ProposalCategory] = entry;
  }
  return { ok: true, value };
}

export function registerRulesRoutes(app: FastifyInstance, deps: RulesRoutesDeps): void {
  app.get("/rules", { preHandler: requirePermission("console.view") }, async (req) => {
    const principal = req.principal!; // set by the enclosing requireMerchant preHandler
    const ctx = { tenantId: principal.merchantId };
    const envelope = await deps.rulesStore.get(ctx);
    return { envelope };
  });

  app.put<{ Body: unknown }>("/rules", { preHandler: requirePermission("rules.edit") }, async (req, reply) => {
    const principal = req.principal!;
    const ctx = { tenantId: principal.merchantId };

    const validated = validateRuleSetBody(req.body);
    if (!validated.ok) {
      return reply.code(400).send({ error: "invalid rule set", reason: validated.reason });
    }

    const { envelope, bigJump } = await deps.rulesStore.set(ctx, validated.value, principal.userId, "merchant_set");
    return { envelope, bigJump };
  });
}
