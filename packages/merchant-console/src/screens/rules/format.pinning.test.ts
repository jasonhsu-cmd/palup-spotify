import { describe, it, expect } from "vitest";
import {
  AUTO_ELIGIBLE_DIMENSIONS as REAL_AUTO_ELIGIBLE_DIMENSIONS,
  clampToFloor,
  PALUP_FLOORS,
  type CategoryRuleEnvelope,
  type ProposalCategory,
} from "@palup/platform-ports";
import { AUTO_ELIGIBLE_DIMENSIONS, localClampToFloor } from "./format";

// Review-mandated pinning test (Task 9 follow-up finding): `format.ts` cannot value-import
// `@palup/platform-ports` (it would break `vite build` for this browser console — see the
// build-safety note in format.ts, verified by reproducing the failure). So the honesty display's
// effective-value math (`localClampToFloor`) and dimension map (`AUTO_ELIGIBLE_DIMENSIONS`) are
// hand-mirrored there instead of imported.
//
// THIS test file is never bundled into the browser build — it only runs under vitest's node/jsdom
// test environment — so it is the one place allowed to import the REAL `clampToFloor`/
// `PALUP_FLOORS`/`AUTO_ELIGIBLE_DIMENSIONS` and cross-check the local mirror against them. If
// `format.ts`'s copy ever drifts from the real platform-ports logic, this test fails — closing the
// "nothing enforces it" gap the review flagged.

const CATEGORIES: ProposalCategory[] = [
  "discount", "ad_spend", "refund", "campaign", "subscription", "autonomy_scope",
];

// A spread of merchant values per numeric dimension: below the real floor, exactly at it, above it
// (the case that must clamp), and undefined (falls back to the floor). Cheap to enumerate per
// category since PALUP_FLOORS is small and fixed.
function envelopesFor(category: ProposalCategory): CategoryRuleEnvelope[] {
  const floor = PALUP_FLOORS[category];
  const pctValues = [undefined, 0, Math.max(0, floor.maxAutoPct - 5), floor.maxAutoPct, floor.maxAutoPct + 20, 999];
  const usdValues = floor.maxAutoUsd !== undefined
    ? [undefined, 0, Math.max(0, floor.maxAutoUsd - 5), floor.maxAutoUsd, floor.maxAutoUsd + 100, 999999]
    : [undefined, 0, 999];
  const periodValues = floor.maxAutoPeriodUsd !== undefined
    ? [undefined, 0, floor.maxAutoPeriodUsd - 100, floor.maxAutoPeriodUsd, floor.maxAutoPeriodUsd + 1000]
    : [undefined, 0, 999];
  const priceMatchValues = usdValues;

  const envelopes: CategoryRuleEnvelope[] = [];
  for (const allowedAuto of [true, false]) {
    for (const maxPct of pctValues) {
      for (const maxUsd of usdValues) {
        for (const periodBudgetUsd of periodValues) {
          for (const priceMatchMaxUsd of priceMatchValues) {
            envelopes.push({
              allowedAuto,
              ...(maxPct !== undefined ? { maxPct } : {}),
              ...(maxUsd !== undefined ? { maxUsd } : {}),
              ...(periodBudgetUsd !== undefined ? { periodBudgetUsd } : {}),
              ...(priceMatchMaxUsd !== undefined ? { priceMatchMaxUsd } : {}),
            });
          }
        }
      }
    }
  }
  return envelopes;
}

describe("format.ts's local platform-ports mirror stays pinned to the real one", () => {
  it("AUTO_ELIGIBLE_DIMENSIONS deep-equals the real @palup/platform-ports export for every category", () => {
    // Not a tautology: this compares format.ts's hand-written copy against the REAL, imported
    // constant. A future edit to either one without the other fails here.
    expect(AUTO_ELIGIBLE_DIMENSIONS).toEqual(REAL_AUTO_ELIGIBLE_DIMENSIONS);
    for (const cat of CATEGORIES) {
      expect(AUTO_ELIGIBLE_DIMENSIONS[cat]).toEqual(REAL_AUTO_ELIGIBLE_DIMENSIONS[cat]);
    }
  });

  it.each(CATEGORIES)(
    "localClampToFloor(%s) matches the real clampToFloor for a spread of below/at/above-floor merchant values",
    (category) => {
      const floor = PALUP_FLOORS[category];
      const envelopes = envelopesFor(category);
      expect(envelopes.length).toBeGreaterThan(10); // sanity: this is a real spread, not one case

      let sawAboveFloorCase = false;
      for (const env of envelopes) {
        const real = clampToFloor(env, floor);
        const local = localClampToFloor(env, floor);
        // Full structural equality — every field the real clamp returns, not just the ones this
        // screen happens to render today.
        expect(local).toEqual(real);

        if (
          (env.maxPct !== undefined && env.maxPct > floor.maxAutoPct) ||
          (floor.maxAutoUsd !== undefined && env.maxUsd !== undefined && env.maxUsd > floor.maxAutoUsd) ||
          (floor.maxAutoPeriodUsd !== undefined && env.periodBudgetUsd !== undefined && env.periodBudgetUsd > floor.maxAutoPeriodUsd) ||
          (floor.maxAutoUsd !== undefined && env.priceMatchMaxUsd !== undefined && env.priceMatchMaxUsd > floor.maxAutoUsd)
        ) {
          sawAboveFloorCase = true;
          // The whole point: an above-floor merchant value must clamp DOWN to the floor in both
          // implementations, identically — never pass through unclamped in either.
          if (env.maxPct !== undefined && env.maxPct > floor.maxAutoPct) {
            expect(local.maxPct).toBe(floor.maxAutoPct);
            expect(real.maxPct).toBe(floor.maxAutoPct);
          }
        }
      }
      // Every category's spread includes at least one genuinely-above-floor case (guards against
      // `envelopesFor` silently degenerating into only below/at-floor values for some category).
      expect(sawAboveFloorCase).toBe(true);
    },
  );

  it("a hand-broken local mirror WOULD be caught (meta-check that this is a real cross-check, not a tautology)", () => {
    // Deliberately wrong clamp: forgets to clamp maxPct to the floor at all. If localClampToFloor
    // were this broken, the equality above would fail — proving the test isn't vacuously true.
    const floor = PALUP_FLOORS.discount;
    const env: CategoryRuleEnvelope = { allowedAuto: true, maxPct: 90 };
    const real = clampToFloor(env, floor);
    const brokenLocal = { ...localClampToFloor(env, floor), maxPct: env.maxPct };
    expect(brokenLocal).not.toEqual(real);
    // And the actual (non-broken) local mirror DOES match — this is the real assertion the other
    // tests above rely on.
    expect(localClampToFloor(env, floor)).toEqual(real);
  });
});
