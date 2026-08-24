// classifyAction — the HITL classifier (docs/HITL-POLICY.md). Every autonomous `AgentAction` a
// run-time agent wants to take is run through here BEFORE it executes; the result says whether it
// may proceed unattended ("auto") or must instead be emitted as an Approval Center `Proposal`
// ("requires_approval") — never executed directly when boundary-crossing (CLAUDE.md §3.1).
//
// SEAM, NOT POLICY: this module reads a `RulesProvider` for the tunable numbers (the merchant's
// auto-act limit, PalUp's platform-wide floor) — it does not own or hardcode them. W4-min supplies
// the real, merchant-configured implementation; E1's tests use a fake. `classifyAction` itself
// carries only the FIXED, inviolable invariants below — those are never delegated to a rule, because
// a rule provider is exactly the kind of surface a compromised or misconfigured merchant/tenant
// setting could turn into a bypass.
//
// Fail-closed invariants (do not weaken without a HITL-POLICY change + human sign-off):
//   1. A mass send (`blastRadius >= palupFloor().massSendRecipientFloor`) is ALWAYS
//      `requires_approval`, regardless of any merchant auto-act setting — a permanent floor, not a
//      configurable one.
//   2. An action type this module cannot map to a known `ProposalCategory` defaults to
//      `requires_approval` (category `autonomy_scope`) — never guessed into "auto".
//   3. Exceeding either the merchant's `autoActLimit` OR PalUp's `palupFloor` (whichever is
//      stricter) requires approval, with a traceable `BoundaryReason`.
//   4. Any other uncertainty (e.g. an action of a known category with no measurable pct/usd param to
//      check against a limit) also defaults to `requires_approval` — never "auto" by default.
//
// Determinism: no `Date.now()`/`Math.random()` here — classification is a pure function of
// (action, ctx, rules-at-call-time).

import { AUTO_ELIGIBLE_DIMENSIONS } from "@palup/platform-ports";
import type { AgentAction, AutoActLimit, BoundaryReason, PalupFloor, ProposalCategory } from "@palup/platform-ports";

// `AutoActLimit`/`PalupFloor` are DEFINED in `@palup/platform-ports` (`merchant-rules-store.ts`) — moved
// there so `@palup/state-postgres`'s `PostgresMerchantRulesStore` can implement `MerchantRulesStore`
// (which uses these shapes via `clampToFloor`) without a package cycle (`agent-runtime` already depends
// on `state-postgres`). NOT re-exported from here (only USED, below, by `RulesProvider`) — `./rules.js`
// is the one place that re-exports them (avoids `index.ts`'s `export *` from both files colliding on
// the same names); a caller wanting the type by name imports it from there / `@palup/agent-runtime`'s
// index, same shape either way:
//   - `AutoActLimit` — the merchant-configured ceiling for auto-acting in one category, as W4-min
//     (Rules) resolves it for this tenant/category/action. Either field may be absent when not
//     applicable to the category (e.g. a refund cares about `maxUsd`, a discount about `maxPct`).
//   - `PalupFloor` — PalUp's platform-wide, non-merchant-configurable ceiling — the floor under every
//     merchant's own (possibly looser) `autoActLimit`. These are the numbers CLAUDE.md §3 calls
//     "inviolable." `massSendRecipientFloor` is the recipient/blast-radius count at or above which a
//     send is ALWAYS `requires_approval` — see invariant 1 below — the one number `classifyAction`
//     itself enforces no matter what any `RulesProvider` returns.

/** The seam `classifyAction` reads for the two tunables above. W4-min (Rules) implements this for
 * real, merchant-scoped config; tests supply a fake. Return values may be sync or async so a simple
 * in-memory fake and a real, store-backed provider can share the same shape. */
export interface RulesProvider {
  autoActLimit(
    ctx: { tenantId: string },
    category: ProposalCategory,
    action: AgentAction,
  ): AutoActLimit | Promise<AutoActLimit>;
  palupFloor(): PalupFloor | Promise<PalupFloor>;
}

export interface Classification {
  decision: "auto" | "requires_approval";
  category: ProposalCategory;
  /** Empty when `decision === "auto"`; always non-empty (at least one entry) when
   * `requires_approval` — every boundary crossing is traceable to a specific rule. */
  boundaryReasons: BoundaryReason[];
}

interface CategoryResult {
  category: ProposalCategory;
  /** Non-empty only when the action's `type` could not be mapped to a known category — this ALSO
   * means the action is unclassifiable and must default to `requires_approval` (invariant 2). */
  boundaryReasons: BoundaryReason[];
}

// Known action-type -> ProposalCategory mapping. Deliberately narrow and explicit: an action type
// not listed here is NOT guessed at — it falls through to the `autonomy_scope` / requires_approval
// default in `categoryForAction`.
const ACTION_TYPE_CATEGORY: Readonly<Record<string, ProposalCategory>> = {
  issue_discount: "discount",
  issue_refund: "refund",
  send_campaign: "campaign",
  run_ad_campaign: "ad_spend",
  change_subscription: "subscription",
};

/** Maps an `AgentAction.type` to its `ProposalCategory`. An unmapped type defaults to
 * `autonomy_scope` with a `BoundaryReason` explaining why — never silently coerced into a known,
 * possibly-auto-eligible category. */
export function categoryForAction(action: AgentAction): CategoryResult {
  const category = ACTION_TYPE_CATEGORY[action.type];
  if (!category) {
    return {
      category: "autonomy_scope",
      boundaryReasons: [
        {
          rule: "unknown_action_type",
          detail: `no ProposalCategory mapping for action.type="${action.type}" — defaulting to autonomy_scope, requires_approval`,
        },
      ],
    };
  }
  return { category, boundaryReasons: [] };
}

function numericParam(action: AgentAction, key: string): number | undefined {
  const v = action.params[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** True when this action carries a category-specific dimension the new gates below evaluate — so an
 *  action that is "measured" on a categorical dimension (e.g. a subscription pause with no pct/usd)
 *  is NOT rejected by invariant 4's pct/usd-only "unmeasured" default. Presence only — the gates
 *  themselves decide auto vs approval. */
function categoricalDimensionPresent(action: AgentAction, category: ProposalCategory): boolean {
  if (category === "discount") return action.params.stack === true || Array.isArray(action.params.stackWith);
  if (category === "refund") return action.params.priceMatch === true;
  if (category === "subscription") return typeof action.params.subAction === "string";
  return false;
}

/**
 * Classify one `AgentAction` for HITL purposes. See the module header for the fail-closed
 * invariants this enforces. Pure given its inputs (no `Date.now()`), but reads `rules` (a seam) so
 * the tunable numbers are never hardcoded here.
 */
export async function classifyAction(
  action: AgentAction,
  ctx: { tenantId: string },
  rules: RulesProvider,
): Promise<Classification> {
  const { category, boundaryReasons: categoryReasons } = categoryForAction(action);
  const floor = await rules.palupFloor();

  // Invariant 1 — the inviolable mass-send floor. Checked FIRST and unconditionally: no merchant
  // rule, category mapping, or per-action override can move this action to "auto" once its
  // blastRadius crosses the platform floor.
  if ((action.blastRadius ?? 0) >= floor.massSendRecipientFloor) {
    return {
      decision: "requires_approval",
      category,
      boundaryReasons: [
        ...categoryReasons,
        {
          rule: "mass_send_floor",
          detail: `blastRadius=${action.blastRadius} >= massSendRecipientFloor=${floor.massSendRecipientFloor}`,
        },
      ],
    };
  }

  // Invariant 2 — unclassifiable action types never reach the auto-act check at all.
  if (categoryReasons.length > 0) {
    return { decision: "requires_approval", category, boundaryReasons: categoryReasons };
  }

  const limit = await rules.autoActLimit(ctx, category, action);
  if (!limit.allowedAuto) {
    return {
      decision: "requires_approval",
      category,
      boundaryReasons: [
        {
          rule: `${category}.auto_not_allowed`,
          detail: `merchant has not enabled auto-act for category "${category}"`,
        },
      ],
    };
  }

  const pct = numericParam(action, "pct");
  const usd = numericParam(action, "usd");
  const hasCategorical = categoricalDimensionPresent(action, category);

  // Invariant 4 (preserved, generalized): a known category with NOTHING measurable — no pct, no usd,
  // AND no category-specific dimension — is uncertainty, not a free pass.
  if (pct === undefined && usd === undefined && !hasCategorical) {
    return {
      decision: "requires_approval",
      category,
      boundaryReasons: [
        {
          rule: `${category}.unmeasured_action`,
          detail: "no pct/usd/categorical param present to evaluate against the auto-act limit",
        },
      ],
    };
  }

  // F2 FIX (§3-critical): evaluate EVERY dimension present on the action — never short-circuit on
  // just `pct` and return "auto" before `usd` (or vice versa) has even been checked. The prior code
  // checked `pct` first and RETURNED on that branch alone, so a dollar-denominated action (e.g.
  // `run_ad_campaign`) carrying BOTH a `pct` and a `usd` param could pass its (often generous) pct
  // cap and never have its usd cap evaluated at all — bypassing the dollar ceiling entirely. Now
  // every present dimension is checked and ALL of their reasons are collected; the decision is
  // "auto" only when every present dimension passed.
  //
  // FOLLOW-UP §3 FIX: some categories (e.g. `refund`, `ad_spend`) are given a `maxAutoPct:100`
  // floor purely as a structural no-op so `withinFloor`'s pct-AND-usd gate has a number on both
  // sides (`@palup/platform-ports`'s `PALUP_FLOORS` comment) — NOT because they are actually
  // percentage-auto-eligible. Without a separate check, a `refund` action carrying ONLY a `pct`
  // param (no `usd`) would be "measured" (this is not the invariant-4 case above) and checked
  // against that no-op 100% cap, auto-approving a refund of ARBITRARY dollar size — the real $200
  // USD floor never evaluated at all. `AUTO_ELIGIBLE_DIMENSIONS[category]` is the authoritative
  // list of which dimensions a category is ACTUALLY auto-eligible on; a dimension present on the
  // action but absent from that list is `requires_approval` with an `unexpected_dimension` reason
  // — it is NEVER checked against that category's (possibly no-op) numeric cap.
  const eligibleDimensions = AUTO_ELIGIBLE_DIMENSIONS[category];
  const boundaryReasons: BoundaryReason[] = [];

  if (pct !== undefined) {
    if (!eligibleDimensions.includes("pct")) {
      boundaryReasons.push({
        rule: `${category}.unexpected_dimension`,
        detail: `pct=${pct} present but "${category}" is not auto-eligible on the pct dimension (eligible: [${eligibleDimensions.join(", ")}]) — never checked against a possibly no-op percentage cap`,
      });
    } else {
      const cap = Math.min(limit.maxPct ?? Number.POSITIVE_INFINITY, floor.maxAutoPct);
      if (pct > cap) {
        boundaryReasons.push({
          rule: `${category}.pct_over_cap`,
          detail: `pct=${pct} exceeds cap=${cap} (merchant maxPct=${limit.maxPct ?? "n/a"}, palupFloor maxAutoPct=${floor.maxAutoPct})`,
        });
      }
    }
  }

  if (usd !== undefined) {
    if (!eligibleDimensions.includes("usd")) {
      boundaryReasons.push({
        rule: `${category}.unexpected_dimension`,
        detail: `usd=${usd} present but "${category}" is not auto-eligible on the usd dimension (eligible: [${eligibleDimensions.join(", ")}]) — never checked against a possibly no-op dollar cap`,
      });
    } else {
      // FAIL CLOSED: an absent USD ceiling on EITHER side must never widen autonomy. Unlike
      // `maxAutoPct` (required on `PalupFloor`, so the pct check above always has a real number to
      // cap against), both `limit.maxUsd` and `floor.maxAutoUsd` are optional — treating a missing
      // one as `Infinity` (a prior bug) let ANY dollar amount auto-approve whenever neither side
      // bothered to configure a cap. No effective ceiling from either side is uncertainty, not
      // permission — default to `requires_approval` (CLAUDE.md §3 non-negotiable #1: money never
      // auto-applies).
      if (limit.maxUsd === undefined && floor.maxAutoUsd === undefined) {
        boundaryReasons.push({
          rule: `${category}.no_usd_ceiling`,
          detail: `usd=${usd} but neither the merchant autoActLimit nor the palupFloor configures a maxUsd — an absent cap is never treated as unlimited`,
        });
      } else {
        const cap = Math.min(limit.maxUsd ?? Number.POSITIVE_INFINITY, floor.maxAutoUsd ?? Number.POSITIVE_INFINITY);
        if (usd > cap) {
          boundaryReasons.push({
            rule: `${category}.usd_over_cap`,
            detail: `usd=${usd} exceeds cap=${cap} (merchant maxUsd=${limit.maxUsd ?? "n/a"}, palupFloor maxAutoUsd=${floor.maxAutoUsd ?? "n/a"})`,
          });
        }
      }
    }
  }

  // --- Categorical gates (W4-broaden): each fails CLOSED — an absent/empty policy ⇒ requires_approval.
  if (category === "discount") {
    const stacking = action.params.stack === true || (Array.isArray(action.params.stackWith) && action.params.stackWith.length > 0);
    if (stacking && !limit.stackable) {
      boundaryReasons.push({ rule: "discount.stacking_not_allowed", detail: "the agent tried to stack this discount but merchant rules do not allow auto-stacking" });
    }
  }
  if (category === "refund" && action.params.priceMatch === true) {
    const cap = limit.priceMatchMaxUsd ?? 0; // absent ⇒ 0, fail-closed
    if (usd === undefined || usd > cap) {
      boundaryReasons.push({ rule: "refund.price_match_over_cap", detail: `price-match credit usd=${usd ?? "n/a"} exceeds the auto price-match cap=${cap}` });
    }
  }
  if (category === "subscription") {
    const sub = typeof action.params.subAction === "string" ? action.params.subAction : undefined;
    const allowed = limit.subscriptionSelfServe ?? [];
    if (sub === undefined || !allowed.includes(sub as (typeof allowed)[number])) {
      boundaryReasons.push({ rule: "subscription.action_requires_approval", detail: `subscription subAction="${sub ?? "n/a"}" is not in the merchant self-serve allow-list [${allowed.join(", ")}]` });
    }
  }

  if (boundaryReasons.length > 0) {
    return { decision: "requires_approval", category, boundaryReasons };
  }

  return { decision: "auto", category, boundaryReasons: [] };
}
