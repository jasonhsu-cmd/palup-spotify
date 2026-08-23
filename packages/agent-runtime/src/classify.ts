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

import type { AgentAction, BoundaryReason, ProposalCategory } from "./types.js";

/** The merchant-configured ceiling for auto-acting in one category, as W4-min (Rules) resolves it
 * for this tenant/category/action. Either field may be absent when not applicable to the category
 * (e.g. a refund cares about `maxUsd`, a discount about `maxPct`). */
export interface AutoActLimit {
  /** Percentage cap (e.g. discount %), if this category is percentage-denominated. */
  maxPct?: number;
  /** USD cap (e.g. refund/ad-spend amount), if this category is dollar-denominated. */
  maxUsd?: number;
  /** Whether the merchant has enabled auto-act for this category at all. `false` forces approval
   * even when every numeric check would otherwise pass. */
  allowedAuto: boolean;
}

/** PalUp's platform-wide, non-merchant-configurable ceiling — the floor under every merchant's own
 * (possibly looser) `autoActLimit`. These are the numbers CLAUDE.md §3 calls "inviolable." */
export interface PalupFloor {
  /** Platform-wide max auto-act percentage, regardless of what a merchant configures higher. */
  maxAutoPct: number;
  /** Platform-wide max auto-act USD amount, if applicable. */
  maxAutoUsd?: number;
  /** Recipient/blast-radius count at or above which a send is ALWAYS `requires_approval` — see
   * invariant 1. This is the one number `classifyAction` itself enforces no matter what any
   * `RulesProvider` returns. */
  massSendRecipientFloor: number;
}

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

  if (pct !== undefined) {
    const cap = Math.min(limit.maxPct ?? Number.POSITIVE_INFINITY, floor.maxAutoPct);
    if (pct > cap) {
      return {
        decision: "requires_approval",
        category,
        boundaryReasons: [
          {
            rule: `${category}.pct_over_cap`,
            detail: `pct=${pct} exceeds cap=${cap} (merchant maxPct=${limit.maxPct ?? "n/a"}, palupFloor maxAutoPct=${floor.maxAutoPct})`,
          },
        ],
      };
    }
    return { decision: "auto", category, boundaryReasons: [] };
  }

  if (usd !== undefined) {
    const cap = Math.min(limit.maxUsd ?? Number.POSITIVE_INFINITY, floor.maxAutoUsd ?? Number.POSITIVE_INFINITY);
    if (usd > cap) {
      return {
        decision: "requires_approval",
        category,
        boundaryReasons: [
          {
            rule: `${category}.usd_over_cap`,
            detail: `usd=${usd} exceeds cap=${cap} (merchant maxUsd=${limit.maxUsd ?? "n/a"}, palupFloor maxAutoUsd=${floor.maxAutoUsd ?? "n/a"})`,
          },
        ],
      };
    }
    return { decision: "auto", category, boundaryReasons: [] };
  }

  // Invariant 4 — a known category with nothing measurable to check against a limit is uncertainty,
  // not a free pass: default to requires_approval.
  return {
    decision: "requires_approval",
    category,
    boundaryReasons: [
      {
        rule: `${category}.unmeasured_action`,
        detail: "no pct/usd param present to evaluate against the auto-act limit",
      },
    ],
  };
}
