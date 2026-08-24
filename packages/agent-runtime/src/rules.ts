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
//
// Task 1's constants + Task 2's store (and `clampToFloor`) NOW LIVE in `@palup/platform-ports`
// (`merchant-rules-store.ts`) — moved there so `@palup/state-postgres`'s `PostgresMerchantRulesStore`
// (task 5) can implement `MerchantRulesStore` WITHOUT a package cycle: `agent-runtime` already depends
// on `state-postgres` for the shared kill registry (`kill.ts`), so `state-postgres` importing these
// types from `@palup/agent-runtime` would form `state-postgres -> agent-runtime -> state-postgres` —
// exactly the cycle `ProposalStore`/`MerchantRegistryPort` were moved to `platform-ports` to avoid. This
// file RE-EXPORTS everything below so every existing `../src/rules.js` import (this package's own
// tests) keeps resolving unchanged. `createRulesProvider` (task 3) STAYS here: it returns
// `classify.ts`'s `RulesProvider`, which is engine LOOP wiring, not the port.

import type { RuntimeStateCtx } from "@palup/platform-ports";
import type { AgentAction, ProposalCategory } from "@palup/platform-ports";
import {
  CONSERVATIVE_DEFAULTS,
  PALUP_FLOORS,
  AUTO_ELIGIBLE_DIMENSIONS,
  clampToFloor,
  InMemoryMerchantRulesStore,
  effectiveCategory,
  mergeOverDefaults,
  isBigJump,
  type AutoActLimit,
  type AutoEligibleDimension,
  type CategoryRuleEnvelope,
  type MerchantRuleSet,
  type MerchantRulesStore,
  type PalupFloor,
  type RuleProvenance,
  type RuleSetChangeResult,
} from "@palup/platform-ports";
import type { RulesProvider } from "./classify.js";

export {
  CONSERVATIVE_DEFAULTS,
  PALUP_FLOORS,
  AUTO_ELIGIBLE_DIMENSIONS,
  clampToFloor,
  InMemoryMerchantRulesStore,
  effectiveCategory,
  mergeOverDefaults,
  isBigJump,
};
export type {
  AutoActLimit,
  AutoEligibleDimension,
  CategoryRuleEnvelope,
  MerchantRuleSet,
  MerchantRulesStore,
  PalupFloor,
  RuleProvenance,
  RuleSetChangeResult,
};

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

// `withinFloor`/`clampToFloor` themselves now live in `@palup/platform-ports` (imported + re-exported
// above) — the fail-closed clamp logic and its rationale are documented there, unchanged.

/**
 * Builds E1's `RulesProvider` on top of a `MerchantRulesStore`: `autoActLimit` reads the merchant's
 * stored envelope for the category and delegates to `clampToFloor` against `PALUP_FLOORS[category]`
 * — the merchant can only ever be as permissive as (or tighter than) the platform floor, never
 * looser, even if the stored envelope itself is misconfigured (e.g. `maxPct: 100` or an absurd
 * `maxUsd`). `palupFloor` returns the fixed, category-agnostic `GLOBAL_PALUP_FLOOR` (see above for
 * why it must be category-agnostic and why its specific numbers are safe).
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
      return clampToFloor(envelope, PALUP_FLOORS[category]);
    },
    palupFloor(): PalupFloor {
      return GLOBAL_PALUP_FLOOR;
    },
  };
}
