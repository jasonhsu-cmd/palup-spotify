import type { ProposalCategory } from "./proposal-store.js";
import type { RuntimeStateCtx, RuntimeStatePort } from "./runtime-state-port.js";

// Merchant automation-rules domain (W4-min; docs/superpowers/plans/2026-08-23-W4min-automation-rules.md).
// Lives here (not in `@palup/agent-runtime`) for the SAME reason `ProposalStore`/`MerchantRegistryPort`
// do (see `proposal-store.ts`'s header): a Postgres-backed adapter (`PostgresMerchantRulesStore`,
// `@palup/state-postgres`) must be able to import this port/types WITHOUT creating a package cycle with
// `@palup/agent-runtime` (which already depends on `@palup/state-postgres` for the shared kill registry —
// `kill.ts`). `@palup/agent-runtime`'s `src/rules.ts` RE-EXPORTS everything below so every existing
// `../src/rules.js` import in its own tests keeps resolving unchanged; `createRulesProvider` (the adapter
// from a `MerchantRulesStore` into E1's `RulesProvider`) STAYS in `agent-runtime/src/rules.ts` — that
// function returns `classify.ts`'s `RulesProvider`, which is engine LOOP wiring, not the port.
//
// `AutoActLimit`/`PalupFloor` ALSO move here (they were previously local to `agent-runtime/src/
// classify.ts`): `clampToFloor` below needs both as plain data shapes, and `classify.ts` re-exports them
// unchanged from here so nothing importing `type AutoActLimit`/`type PalupFloor` from `"../src/
// classify.js"` sees a different shape. `RulesProvider`/`Classification`/`classifyAction` themselves are
// NOT moved — those ARE the engine loop and stay in `classify.ts`.
//
// Pin these signatures exactly; do not change them without updating every consumer: W4-min
// (`createRulesProvider`, `agent-runtime/src/rules.ts`), the classifier (`agent-runtime/src/classify.ts`
// — `AutoActLimit`/`PalupFloor`), and Task 4's `merchant-backend` `GET/PUT /rules` routes (not yet built).

// --- Task 1: PALUP_FLOORS + CONSERVATIVE_DEFAULTS -----------------------------------------------

/** One category's merchant-configurable automation envelope, as stored/merged by
 * `MerchantRulesStore`. Shares its numeric shape with `AutoActLimit` — this IS the per-category entry a
 * merchant's stored rule set holds; `createRulesProvider` (agent-runtime) reads one of these and clamps
 * it into an `AutoActLimit` at classify-time via `clampToFloor`. */
export interface CategoryRuleEnvelope {
  allowedAuto: boolean;
  maxPct?: number;
  maxUsd?: number;
}

/** A merchant's full automation-rule envelope: one optional entry per `ProposalCategory`. Absent
 * categories fall back to `CONSERVATIVE_DEFAULTS` in `MerchantRulesStore.get`. */
export type MerchantRuleSet = Partial<Record<ProposalCategory, CategoryRuleEnvelope>>;

/** Who/what caused a rule change, for the audit trail (Global Constraints: "every rule change is
 * audited with provenance"). `"merchant_set"` — an explicit merchant console edit (Task 4's `PUT
 * /rules`). `"agent_proposed"` — a future W1 trust-ratchet expansion the merchant approved; W4-min itself
 * never produces this value (no caller does yet), but the type exists so a real caller cannot pass an
 * arbitrary, unvetted string into the immutable log. */
export type RuleProvenance = "merchant_set" | "agent_proposed";

/** The merchant-configured ceiling for auto-acting in one category, as W4-min (Rules) resolves it for
 * this tenant/category/action. Either field may be absent when not applicable to the category (e.g. a
 * refund cares about `maxUsd`, a discount about `maxPct`). Consumed by `classify.ts`'s `RulesProvider`
 * (`agent-runtime`), which re-exports this exact type from here. */
export interface AutoActLimit {
  /** Percentage cap (e.g. discount %), if this category is percentage-denominated. */
  maxPct?: number;
  /** USD cap (e.g. refund/ad-spend amount), if this category is dollar-denominated. */
  maxUsd?: number;
  /** Whether the merchant has enabled auto-act for this category at all. `false` forces approval even
   * when every numeric check would otherwise pass. */
  allowedAuto: boolean;
}

/** PalUp's platform-wide, non-merchant-configurable ceiling — the floor under every merchant's own
 * (possibly looser) `autoActLimit`. These are the numbers CLAUDE.md §3 calls "inviolable." Consumed by
 * `classify.ts`'s `RulesProvider`, which re-exports this exact type from here. */
export interface PalupFloor {
  /** Platform-wide max auto-act percentage, regardless of what a merchant configures higher. */
  maxAutoPct: number;
  /** Platform-wide max auto-act USD amount, if applicable. */
  maxAutoUsd?: number;
  /** Recipient/blast-radius count at or above which a send is ALWAYS `requires_approval` — see
   * `classify.ts`'s invariant 1. This is the one number `classifyAction` itself enforces no matter what
   * any `RulesProvider` returns. */
  massSendRecipientFloor: number;
}

/**
 * PalUp's platform-wide, inviolable ceilings — CLAUDE.md §3 non-negotiable #1 (money never
 * auto-applies past what the platform allows) given concrete numbers. These are NOT
 * merchant-configurable; `createRulesProvider` (agent-runtime) clamps every merchant envelope to these
 * before `classifyAction` ever sees it, and `classifyAction` itself separately enforces the
 * `massSendRecipientFloor` unconditionally (see `classify.ts` invariant 1).
 *
 * Every entry is a `PalupFloor` (mirrors `classify.ts`'s shape exactly) so `createRulesProvider`
 * can return `PALUP_FLOORS[category]` directly from `palupFloor()`.
 */
// F1 hardening (§3-critical review finding): EVERY category below defines a real `maxAutoUsd`, not
// just the categories this module currently treats as "dollar-denominated." Before this fix, a
// category with no `maxAutoUsd` here (discount/campaign/subscription/autonomy_scope) let
// `createRulesProvider` pass a merchant's raw `maxUsd` through UNCLAMPED — e.g. a mis-set
// `{discount:{allowedAuto:true, maxUsd:999999}}` auto-approved a $500,000 "discount" specified in
// dollars rather than percent. `action.params` is caller-supplied `Record<string, unknown>` (no
// schema ties a category to only-pct or only-usd), so ANY category could in principle carry a `usd`
// param — every one now gets a real, conservative dollar ceiling so `clampToFloor`'s clamp is never
// a no-op. See `clampToFloor` below for the second half of the fix (fail-closed when a floor is
// somehow still missing one).
export const PALUP_FLOORS: Readonly<Record<ProposalCategory, PalupFloor>> = {
  // A discount is bounded, reversible (a coupon can be revoked/expired) and self-limiting per order
  // — 30% is deep enough to close most single-order objections without training shoppers to expect
  // near-giveaway pricing or eroding margin on every auto-approved order. A FLAT-DOLLAR discount is
  // the unusual case (most are pct-based), so its dollar ceiling is kept tight — $50 covers a
  // routine order-value credit without approaching refund-scale abuse exposure.
  discount: { maxAutoPct: 30, maxAutoUsd: 50, massSendRecipientFloor: 500 },
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
  // classifier never disagree. A campaign could still carry a dollar "budget" param in a future
  // action shape — $100 is a tight sanity ceiling for that case, well under the ad-spend ceiling.
  campaign: { maxAutoPct: 100, maxAutoUsd: 100, massSendRecipientFloor: 500 },
  // A subscription change (skip/pause/cancel) touches recurring revenue and a standing customer
  // relationship. No percentage describes its risk, but a future action could carry a proration or
  // account-credit dollar amount — $50 is a tight sanity ceiling for that, well under refund's $200.
  subscription: { maxAutoPct: 100, maxAutoUsd: 50, massSendRecipientFloor: 500 },
  // `autonomy_scope` is the fallback bucket `categoryForAction` assigns to any UNMAPPED action type
  // (`classify.ts` invariant 2) — it must never itself be a wide-open category, so BOTH ceilings are
  // pinned to 0: an action landing here has no known shape, so nothing about it — percentage OR
  // dollar — is auto-eligible by floor, only by explicit future re-classification into a real
  // category.
  autonomy_scope: { maxAutoPct: 0, maxAutoUsd: 0, massSendRecipientFloor: 500 },
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
 * `"agent_proposed"`). Every implementer (this in-memory one, `PostgresMerchantRulesStore`) MUST
 * audit `set` itself — unlike `ProposalStore`/`MerchantRegistryPort`, the audit obligation lives on
 * the adapter here, not the caller, because there is no single engine-loop call site that owns it. */
export interface MerchantRulesStore {
  get(ctx: RuntimeStateCtx): Promise<MerchantRuleSet>;
  set(
    ctx: RuntimeStateCtx,
    patch: MerchantRuleSet,
    by: string,
    provenance: RuleProvenance,
  ): Promise<RuleSetChangeResult>;
}

/** One category's effective envelope: the stored patch's entry (if any) layered over
 * `CONSERVATIVE_DEFAULTS`. Exported so every adapter (in-memory, Postgres) computes this identically —
 * a single source of truth for the merge rule, not a re-derived copy per adapter. */
export function effectiveCategory(cat: ProposalCategory, stored: MerchantRuleSet): CategoryRuleEnvelope {
  return { ...(CONSERVATIVE_DEFAULTS[cat] ?? { allowedAuto: false }), ...(stored[cat] ?? {}) };
}

/** The full, defaults-merged envelope for a stored (possibly partial) rule set. Exported for the same
 * single-source-of-truth reason as `effectiveCategory`. */
export function mergeOverDefaults(stored: MerchantRuleSet): MerchantRuleSet {
  const merged: MerchantRuleSet = {};
  for (const cat of Object.keys(CONSERVATIVE_DEFAULTS) as ProposalCategory[]) {
    merged[cat] = effectiveCategory(cat, stored);
  }
  return merged;
}

/** True when moving from `before` to `after` (one category) looks like a meaningful autonomy
 * increase: enabling auto-act at all, or raising a numeric ceiling past the delta thresholds above.
 * Never flags a DECREASE (tightening a rule is always safe, never a "jump" worth flagging). Exported
 * so every adapter computes "big jump" identically — the same single-source-of-truth reason as
 * `mergeOverDefaults`. */
export function isBigJump(before: CategoryRuleEnvelope, after: CategoryRuleEnvelope): boolean {
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
    provenance: RuleProvenance,
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

// --- Task 3 support: clampToFloor — the pure clamp `createRulesProvider` (agent-runtime) uses --------
//
// `createRulesProvider` itself (the adapter into `classify.ts`'s `RulesProvider`) stays in
// `agent-runtime/src/rules.ts` — it is engine-loop wiring, not the port. `clampToFloor` lives here
// because it is pure data manipulation over this module's own types and `PostgresMerchantRulesStore`'s
// tests (parity/contract) may want to exercise it directly without depending on `agent-runtime`.

/** True when this category's OWN `PALUP_FLOORS` entry leaves any room at all for auto-act — false
 * for a category floor-pinned to 0% with no dollar alternative (currently only `autonomy_scope`).
 * `clampToFloor`'s numeric clamp already forces `pct > cap` to fail in that case, but this makes the
 * closure explicit in `allowedAuto` itself too, so a caller inspecting the limit directly sees an
 * honest `allowedAuto: false` rather than a `true` bundled with a `maxPct: 0` that only prevents
 * auto-act via a second computation. */
function withinFloor(floor: PalupFloor): boolean {
  const pctRoom = floor.maxAutoPct > 0;
  const usdRoom = floor.maxAutoUsd === undefined || floor.maxAutoUsd > 0;
  return pctRoom && usdRoom;
}

/**
 * Pure clamp: pulls a merchant's `CategoryRuleEnvelope` down to a `PalupFloor`. Exported so this exact
 * fail-closed semantics can be unit-tested directly against a SYNTHETIC floor — e.g. one that omits
 * `maxAutoUsd` — independent of whatever `PALUP_FLOORS` currently defines (every entry there defines a
 * real `maxAutoUsd` today, task F1a, but this function must not silently rely on that always being true
 * for every category forever).
 *
 * F1(b) — FAIL CLOSED (§3-critical): a merchant-set ceiling above the floor is pulled DOWN to the
 * floor; an absent merchant ceiling defaults to the floor itself (never "unlimited"). And if the
 * FLOOR ITSELF is somehow missing a `maxAutoUsd` for this category, the merchant's `maxUsd` is
 * NEVER passed through unclamped — the effective auto USD cap becomes 0, not the merchant's number
 * and not `Infinity`. An absent platform ceiling is uncertainty, never permission.
 */
export function clampToFloor(envelope: CategoryRuleEnvelope, floor: PalupFloor): AutoActLimit {
  const maxPct = Math.min(envelope.maxPct ?? floor.maxAutoPct, floor.maxAutoPct);
  const maxUsd = floor.maxAutoUsd !== undefined ? Math.min(envelope.maxUsd ?? floor.maxAutoUsd, floor.maxAutoUsd) : 0;
  return {
    maxPct,
    maxUsd,
    allowedAuto: envelope.allowedAuto && withinFloor(floor),
  };
}
