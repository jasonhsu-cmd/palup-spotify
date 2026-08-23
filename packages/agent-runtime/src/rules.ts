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
