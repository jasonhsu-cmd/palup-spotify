// W4-min — the merchant automation-rules domain that IMPLEMENTS E1's `RulesProvider` seam
// (`./classify.ts`). Three layers, built incrementally (task-1/2/3 in
// `.superpowers/sdd/2026-08-23-W4min-automation-rules/`):
//   1. `PALUP_FLOORS` (inviolable platform ceilings) + `CONSERVATIVE_DEFAULTS` (safe new-tenant
//      envelope) — pure constants, no store.
//   2. `MerchantRulesStore` (+ `InMemoryMerchantRulesStore`) — the tenant-scoped, audited store for
//      a merchant's OWN automation envelope, merged over the conservative defaults.
//   3. `createRulesProvider(store)` — adapts the store into E1's `RulesProvider`, clamping every
//      merchant envelope to the PalUp floor so a mis-set (or compromised) merchant setting can never
//      exceed the platform-wide ceiling `classifyAction` trusts.

import type { RuntimeStateCtx, RuntimeStatePort } from "@palup/platform-ports";
import type { AgentAction, ProposalCategory } from "@palup/platform-ports";
import type { AutoActLimit, PalupFloor, RulesProvider } from "./classify.js";

// --- Task 1: PALUP_FLOORS + CONSERVATIVE_DEFAULTS -----------------------------------------------

/** One category's merchant-configurable automation envelope, as stored/merged by
 * `MerchantRulesStore`. Shares its numeric shape with `AutoActLimit` (`classify.ts`) — this IS the
 * per-category entry a merchant's stored rule set holds; `createRulesProvider` reads one of these
 * and clamps it into an `AutoActLimit` at classify-time. */
export interface CategoryRuleEnvelope {
  allowedAuto: boolean;
  maxPct?: number;
  maxUsd?: number;
}

/** A merchant's full automation-rule envelope: one optional entry per `ProposalCategory`. Absent
 * categories fall back to `CONSERVATIVE_DEFAULTS` in `MerchantRulesStore.get`. */
export type MerchantRuleSet = Partial<Record<ProposalCategory, CategoryRuleEnvelope>>;

/**
 * PalUp's platform-wide, inviolable ceilings — CLAUDE.md §3 non-negotiable #1 (money never
 * auto-applies past what the platform allows) given concrete numbers. These are NOT
 * merchant-configurable; `createRulesProvider` (task 3) clamps every merchant envelope to these
 * before `classifyAction` ever sees it, and `classifyAction` itself separately enforces the
 * `massSendRecipientFloor` unconditionally (see `classify.ts` invariant 1).
 *
 * Every entry is a `PalupFloor` (mirrors `classify.ts`'s shape exactly) so `createRulesProvider`
 * can return `PALUP_FLOORS[category]` directly from `palupFloor()`.
 */
export const PALUP_FLOORS: Readonly<Record<ProposalCategory, PalupFloor>> = {
  // A discount is bounded, reversible (a coupon can be revoked/expired) and self-limiting per order
  // — 30% is deep enough to close most single-order objections without training shoppers to expect
  // near-giveaway pricing or eroding margin on every auto-approved order.
  discount: { maxAutoPct: 30, massSendRecipientFloor: 500 },
  // Ad spend is real cash leaving the merchant's account with delayed, hard-to-reverse feedback
  // (a bad campaign can burn budget for days before ROAS data catches it) — $500/action caps the
  // blast radius of one automated buy while a human still owns the campaign-level budget.
  ad_spend: { maxAutoPct: 100, maxAutoUsd: 500, massSendRecipientFloor: 500 },
  // A refund is the single easiest abuse vector for a chat agent (a shopper can talk an agent into
  // "just refund me") — $200/action is an explicit anti-abuse ceiling: enough to resolve routine
  // order issues, low enough that a fraud ring working the auto-refund path can't scale past it
  // before the pattern shows up in review.
  refund: { maxAutoPct: 100, maxAutoUsd: 200, massSendRecipientFloor: 500 },
  // A campaign send's damage is reach, not dollars — mirrored by `classifyAction`'s own
  // `massSendRecipientFloor` invariant (blastRadius >= 500 is ALWAYS requires_approval no matter what
  // any rule returns). 500 matches that hard invariant so the floor here and the one in the
  // classifier never disagree.
  campaign: { maxAutoPct: 100, massSendRecipientFloor: 500 },
  // A subscription change (skip/pause/cancel) touches recurring revenue and a standing customer
  // relationship — no percentage/dollar amount describes its risk, so the floor only carries the
  // mass-send guard; per-category auto-eligibility is still gated by `allowedAuto` below.
  subscription: { maxAutoPct: 100, massSendRecipientFloor: 500 },
  // `autonomy_scope` is the fallback bucket `categoryForAction` assigns to any UNMAPPED action type
  // (`classify.ts` invariant 2) — it must never itself be a wide-open category, so its pct ceiling is
  // the tightest of all (0): an action landing here has no known shape, so nothing about it is
  // auto-eligible by floor, only by explicit future re-classification into a real category.
  autonomy_scope: { maxAutoPct: 0, massSendRecipientFloor: 500 },
};

/**
 * A brand-new tenant's automation envelope BEFORE any merchant has touched the settings —
 * `MerchantRulesStore.get` merges the stored envelope over this. Every category with a real money
 * or reach impact starts `allowedAuto:false` (CLAUDE.md §3 #1: nothing that affects money auto-
 * applies until a human has explicitly opted in), even though `PALUP_FLOORS` above would technically
 * allow smaller auto-acts — the floor is a ceiling, never a default.
 */
export const CONSERVATIVE_DEFAULTS: Readonly<MerchantRuleSet> = {
  discount: { allowedAuto: false },
  ad_spend: { allowedAuto: false },
  refund: { allowedAuto: false },
  // A campaign send is already independently pinned to `requires_approval` past the mass-send floor
  // by `classifyAction` itself; still default it OFF here too so a sub-floor send isn't auto by
  // default for a tenant who hasn't configured anything.
  campaign: { allowedAuto: false },
  subscription: { allowedAuto: false },
  autonomy_scope: { allowedAuto: false },
};

// --- Task 2: MerchantRulesStore + in-memory adapter ---------------------------------------------
//
// Registry pattern over `RuntimeStatePort` (mirrors `cost-cap-registry.ts` /
// `runtime-consent-store.ts`): one KV row per tenant holding whatever the merchant has explicitly
// SET (a possibly-partial `MerchantRuleSet`); `get` always merges it over `CONSERVATIVE_DEFAULTS`
// so an untouched category still returns a safe, fully-populated envelope. Tenant isolation comes
// from `RuntimeStateCtx.tenantId`, which the port itself enforces (a tenant can never read/write
// another tenant's row).

const RULES_COLLECTION = "merchant_rules";
const RULES_KEY = "envelope"; // one row per tenant — the whole rule set, not split per category

// "Big jump" thresholds — a heuristic flag surfaced to the caller (e.g. the merchant console can
// require extra confirmation), NOT itself a HITL boundary; `classifyAction`/`PALUP_FLOORS` are what
// actually gate autonomy. A flip from off to on is always flagged regardless of the numeric delta —
// enabling auto-act at all is the biggest single jump in autonomy a merchant can make.
const BIG_JUMP_PCT_DELTA = 10; // >10 percentage points in one change
const BIG_JUMP_USD_DELTA = 50; // >$50 in one change

/** The result of `MerchantRulesStore.set`: the new EFFECTIVE (defaults-merged) envelope plus
 * whether this particular change looks like a big jump in autonomy. */
export interface RuleSetChangeResult {
  envelope: MerchantRuleSet;
  bigJump: boolean;
}

/** Tenant-scoped store for a merchant's own automation-rule envelope. `get` never returns an
 * incomplete/undefined category — every `ProposalCategory` key is present, defaults-merged. `set`
 * is a PARTIAL patch (only the categories provided are touched) and is fully audited (NN#5): who
 * (`by`), what changed (before/after), and why (`provenance`, e.g. `"merchant_set"` vs
 * `"support_override"`). */
export interface MerchantRulesStore {
  get(ctx: RuntimeStateCtx): Promise<MerchantRuleSet>;
  set(
    ctx: RuntimeStateCtx,
    patch: MerchantRuleSet,
    by: string,
    provenance: string,
  ): Promise<RuleSetChangeResult>;
}

function effectiveCategory(cat: ProposalCategory, stored: MerchantRuleSet): CategoryRuleEnvelope {
  return { ...(CONSERVATIVE_DEFAULTS[cat] ?? { allowedAuto: false }), ...(stored[cat] ?? {}) };
}

function mergeOverDefaults(stored: MerchantRuleSet): MerchantRuleSet {
  const merged: MerchantRuleSet = {};
  for (const cat of Object.keys(CONSERVATIVE_DEFAULTS) as ProposalCategory[]) {
    merged[cat] = effectiveCategory(cat, stored);
  }
  return merged;
}

/** True when moving from `before` to `after` (one category) looks like a meaningful autonomy
 * increase: enabling auto-act at all, or raising a numeric ceiling past the delta thresholds above.
 * Never flags a DECREASE (tightening a rule is always safe, never a "jump" worth flagging). */
function isBigJump(before: CategoryRuleEnvelope, after: CategoryRuleEnvelope): boolean {
  if (!before.allowedAuto && after.allowedAuto) return true;
  if (after.maxPct !== undefined && after.maxPct - (before.maxPct ?? 0) > BIG_JUMP_PCT_DELTA) return true;
  if (after.maxUsd !== undefined && after.maxUsd - (before.maxUsd ?? 0) > BIG_JUMP_USD_DELTA) return true;
  return false;
}

export class InMemoryMerchantRulesStore implements MerchantRulesStore {
  constructor(private readonly store: RuntimeStatePort) {}

  async get(ctx: RuntimeStateCtx): Promise<MerchantRuleSet> {
    const stored = (await this.store.get<MerchantRuleSet>(ctx, RULES_COLLECTION, RULES_KEY)) ?? {};
    return mergeOverDefaults(stored);
  }

  async set(
    ctx: RuntimeStateCtx,
    patch: MerchantRuleSet,
    by: string,
    provenance: string,
  ): Promise<RuleSetChangeResult> {
    // Read-modify-write + audit inside one tx so the stored envelope and its audit record commit
    // together or not at all (NN#5 — no silent/partial state change).
    return this.store.tx(ctx, async (t) => {
      const storedBefore = (await t.get<MerchantRuleSet>(RULES_COLLECTION, RULES_KEY)) ?? {};
      const before = mergeOverDefaults(storedBefore);
      const storedAfter: MerchantRuleSet = { ...storedBefore };
      let bigJump = false;
      for (const [key, envPatch] of Object.entries(patch)) {
        if (!envPatch) continue;
        const cat = key as ProposalCategory;
        const beforeCat = before[cat] ?? { allowedAuto: false };
        const afterCat: CategoryRuleEnvelope = { ...beforeCat, ...envPatch };
        storedAfter[cat] = afterCat;
        if (isBigJump(beforeCat, afterCat)) bigJump = true;
      }
      await t.put(RULES_COLLECTION, RULES_KEY, storedAfter);
      const after = mergeOverDefaults(storedAfter);
      await t.audit({
        actor: by,
        action: "rules.changed",
        input: { patch, provenance },
        decision: { before, after, bigJump },
        reversalPath: `MerchantRulesStore.set(ctx, <before-envelope>, "${by}", "reversal") restores the prior envelope for tenant ${ctx.tenantId}`,
      });
      return { envelope: after, bigJump };
    });
  }
}

// --- Task 3: createRulesProvider — the E1 RulesProvider, floor-clamped -------------------------
//
// IMPORTANT DEVIATION FROM THE TASK-3 BRIEF'S SHORTHAND: the brief describes this as
// `palupFloor(category) = PALUP_FLOORS[category]`, but E1's ALREADY-MERGED `RulesProvider`
// interface (`classify.ts`) pins `palupFloor(): PalupFloor | Promise<PalupFloor>` — no `category`
// argument, called once per `classifyAction` invocation as `rules.palupFloor()`. That signature is
// explicitly "pinned... do not change... without updating every consumer" (`proposal-store.ts`), so
// this module implements against the REAL signature rather than the brief's paraphrase. The
// consequence: `palupFloor()` can only return ONE category-agnostic `PalupFloor`; the actual
// per-category ceiling from `PALUP_FLOORS[category]` is enforced entirely inside `autoActLimit`
// (which DOES receive `category`), by clamping the merchant's envelope down to it before it is ever
// returned. See `GLOBAL_PALUP_FLOOR` below for why its numbers are chosen the way they are.

/**
 * The single, category-agnostic `PalupFloor` handed to `classifyAction` via `palupFloor()`.
 *   - `massSendRecipientFloor` (500): identical across every `PALUP_FLOORS` entry, so any one of
 *     them is the right global value — this is the number `classifyAction` enforces unconditionally
 *     (invariant 1), independent of category.
 *   - `maxAutoPct` (100): the LARGEST `maxAutoPct` across all `PALUP_FLOORS` entries. `classifyAction`
 *     computes `cap = Math.min(limit.maxPct, floor.maxAutoPct)`, and `limit.maxPct` (from
 *     `autoActLimit`, below) is ALREADY clamped to that category's own, possibly tighter,
 *     `PALUP_FLOORS[category].maxAutoPct`. Choosing anything smaller than 100 here (e.g.
 *     `autonomy_scope`'s 0) would let one category's floor silently over-restrict every OTHER
 *     category through a number that has nothing to do with it. This global value is a structural
 *     no-op layered on top of the real, per-category clamp — never a second, independent ceiling.
 *   - no `maxAutoUsd`: unnecessary for the mirror-image reason — `autoActLimit` already returns a
 *     `maxUsd` bounded by `PALUP_FLOORS[category].maxAutoUsd` for every dollar-denominated category
 *     (never `undefined` when that category defines a floor), so `classifyAction`'s fail-closed
 *     "neither side configures a ceiling" branch never fires for them; leaving this `undefined`
 *     avoids repeating the same "must be ≥ every category's own cap" bookkeeping for no benefit.
 */
const GLOBAL_PALUP_FLOOR: Readonly<PalupFloor> = {
  maxAutoPct: 100,
  massSendRecipientFloor: 500,
};

/** True when this category's OWN `PALUP_FLOORS` entry leaves any room at all for auto-act — false
 * for a category floor-pinned to 0% with no dollar alternative (currently only `autonomy_scope`).
 * `autoActLimit`'s numeric clamp already forces `pct > cap` to fail in that case, but this makes the
 * closure explicit in `allowedAuto` itself too, so a caller inspecting the limit directly (not just
 * `classifyAction`'s derived decision) sees an honest `allowedAuto: false` rather than a `true`
 * bundled with a `maxPct: 0` that only prevents auto-act via a second computation. */
function withinFloor(floor: PalupFloor): boolean {
  const pctRoom = floor.maxAutoPct > 0;
  const usdRoom = floor.maxAutoUsd === undefined || floor.maxAutoUsd > 0;
  return pctRoom && usdRoom;
}

/**
 * Builds E1's `RulesProvider` on top of a `MerchantRulesStore`: `autoActLimit` reads the merchant's
 * stored envelope for the category and CLAMPS its numeric ceilings down to `PALUP_FLOORS[category]`
 * — the merchant can only ever be as permissive as (or tighter than) the platform floor, never
 * looser, even if the stored envelope itself is misconfigured (e.g. `maxPct: 100`). `palupFloor`
 * returns the fixed, category-agnostic `GLOBAL_PALUP_FLOOR` (see above for why it must be
 * category-agnostic and why its specific numbers are safe).
 */
export function createRulesProvider(store: MerchantRulesStore): RulesProvider {
  return {
    async autoActLimit(
      ctx: RuntimeStateCtx,
      category: ProposalCategory,
      _action: AgentAction,
    ): Promise<AutoActLimit> {
      const ruleSet = await store.get(ctx);
      const envelope: CategoryRuleEnvelope = ruleSet[category] ?? { allowedAuto: false };
      const floor = PALUP_FLOORS[category];
      // Clamp: a merchant-set ceiling above the floor is pulled DOWN to the floor; an absent
      // merchant ceiling defaults to the floor itself (never "unlimited") — this is what makes the
      // floor a real ceiling rather than advisory.
      const maxPct = Math.min(envelope.maxPct ?? floor.maxAutoPct, floor.maxAutoPct);
      const maxUsd =
        floor.maxAutoUsd !== undefined
          ? Math.min(envelope.maxUsd ?? floor.maxAutoUsd, floor.maxAutoUsd)
          : envelope.maxUsd;
      return {
        maxPct,
        maxUsd,
        allowedAuto: envelope.allowedAuto && withinFloor(floor),
      };
    },
    palupFloor(): PalupFloor {
      return GLOBAL_PALUP_FLOOR;
    },
  };
}
