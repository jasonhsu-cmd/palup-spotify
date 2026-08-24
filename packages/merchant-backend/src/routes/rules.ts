import type { FastifyInstance } from "fastify";
import { requirePermission } from "@palup/identity-shopify";
import {
  PALUP_FLOORS,
  listPresets,
  type CategoryRuleEnvelope,
  type MerchantRuleSet,
  type MerchantRulesStore,
  type ProposalCategory,
  type SubscriptionSubAction,
} from "@palup/platform-ports";

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

const SUBSCRIPTION_ACTIONS: ReadonlySet<string> = new Set<SubscriptionSubAction>(["pause", "skip", "cancel"]);

// Which broadened fields are legal on which category (allowedAuto/maxPct/maxUsd are legal everywhere,
// same as W4-min). A field present on the wrong category is a 400 — never silently dropped or stored.
const CATEGORY_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  discount: new Set(["allowedAuto", "maxPct", "maxUsd", "stackable"]),
  ad_spend: new Set(["allowedAuto", "maxPct", "maxUsd", "roiFloor", "periodBudgetUsd"]),
  refund: new Set(["allowedAuto", "maxPct", "maxUsd", "priceMatchMaxUsd"]),
  subscription: new Set(["allowedAuto", "maxPct", "maxUsd", "subscriptionSelfServe"]),
  campaign: new Set(["allowedAuto", "maxPct", "maxUsd", "frequencyCapPerWeek", "quietHours"]),
  autonomy_scope: new Set(["allowedAuto", "maxPct", "maxUsd"]),
};

function isNum(v: unknown): v is number { return typeof v === "number" && Number.isFinite(v); }

/** Structural + per-category validation of a `PUT /rules` body against `MerchantRuleSet`'s broadened
 *  shape: every top-level key must be a known `ProposalCategory`, every value must be a
 *  `CategoryRuleEnvelope` (a boolean `allowedAuto` plus optional per-category fields), and a field
 *  present on the WRONG category (e.g. `stackable` on `refund`) is rejected rather than silently
 *  dropped or stored. Returns a human-readable reason on failure so the 400 response can say what was
 *  wrong, never a raw echo of the offending value. */
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
    const allowed = CATEGORY_FIELDS[key];
    if (!allowed) return { ok: false, reason: `unknown category: ${key}` };
    for (const f of Object.keys(env)) {
      if (!allowed.has(f)) return { ok: false, reason: `${key}: field "${f}" is not valid for this category` };
    }
    if (typeof env.allowedAuto !== "boolean") {
      return { ok: false, reason: `${key}: allowedAuto must be a boolean` };
    }
    const entry: CategoryRuleEnvelope = { allowedAuto: env.allowedAuto };
    if (env.maxPct !== undefined) {
      if (!isNum(env.maxPct) || env.maxPct < 0) return { ok: false, reason: `${key}: maxPct must be a number ≥ 0` };
      entry.maxPct = env.maxPct;
    }
    if (env.maxUsd !== undefined) {
      if (!isNum(env.maxUsd) || env.maxUsd < 0) return { ok: false, reason: `${key}: maxUsd must be a number ≥ 0` };
      entry.maxUsd = env.maxUsd;
    }
    if (env.stackable !== undefined) {
      if (typeof env.stackable !== "boolean") return { ok: false, reason: `${key}: stackable must be a boolean` };
      entry.stackable = env.stackable;
    }
    if (env.periodBudgetUsd !== undefined) {
      if (!isNum(env.periodBudgetUsd) || env.periodBudgetUsd < 0) return { ok: false, reason: `${key}: periodBudgetUsd must be a number ≥ 0` };
      entry.periodBudgetUsd = env.periodBudgetUsd;
    }
    if (env.roiFloor !== undefined) {
      if (!isNum(env.roiFloor) || env.roiFloor < 0) return { ok: false, reason: `${key}: roiFloor must be a number ≥ 0` };
      entry.roiFloor = env.roiFloor;
    }
    if (env.priceMatchMaxUsd !== undefined) {
      if (!isNum(env.priceMatchMaxUsd) || env.priceMatchMaxUsd < 0) return { ok: false, reason: `${key}: priceMatchMaxUsd must be a number ≥ 0` };
      entry.priceMatchMaxUsd = env.priceMatchMaxUsd;
    }
    if (env.frequencyCapPerWeek !== undefined) {
      if (!Number.isInteger(env.frequencyCapPerWeek) || (env.frequencyCapPerWeek as number) < 0) {
        return { ok: false, reason: `${key}: frequencyCapPerWeek must be an integer ≥ 0` };
      }
      entry.frequencyCapPerWeek = env.frequencyCapPerWeek as number;
    }
    if (env.subscriptionSelfServe !== undefined) {
      const arr = env.subscriptionSelfServe;
      if (!Array.isArray(arr) || !arr.every((a) => typeof a === "string" && SUBSCRIPTION_ACTIONS.has(a))) {
        return { ok: false, reason: `${key}: subscriptionSelfServe must be an array of ${[...SUBSCRIPTION_ACTIONS].join("|")}` };
      }
      entry.subscriptionSelfServe = arr as SubscriptionSubAction[];
    }
    if (env.quietHours !== undefined) {
      const q = env.quietHours as Record<string, unknown>;
      const okHour = (h: unknown) => Number.isInteger(h) && (h as number) >= 0 && (h as number) <= 23;
      if (typeof q !== "object" || q === null || !okHour(q.startHour) || !okHour(q.endHour)) {
        return { ok: false, reason: `${key}: quietHours must be { startHour, endHour } in 0–23` };
      }
      entry.quietHours = { startHour: q.startHour as number, endHour: q.endHour as number };
    }
    value[key as ProposalCategory] = entry;
  }
  return { ok: true, value };
}

export function registerRulesRoutes(app: FastifyInstance, deps: RulesRoutesDeps): void {
  // Read-only: the inviolable PalUp floors and the preset catalog, so the console can render the full
  // three-layer editor (merchant value / PalUp floor / preset). Neither route lets a caller APPLY a
  // preset or change a floor — presets are `allowedAuto:false` everywhere (adopting one still routes
  // through the same validated `PUT /rules`), and floors are platform-wide constants, not per-tenant
  // state.
  app.get("/rules/floors", { preHandler: requirePermission("console.view") }, async () => ({ floors: PALUP_FLOORS }));
  app.get("/rules/presets", { preHandler: requirePermission("console.view") }, async () => ({ presets: listPresets() }));

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
