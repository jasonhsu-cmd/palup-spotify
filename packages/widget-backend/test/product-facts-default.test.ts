import { describe, expect, it } from "vitest";
import { PRODUCT_FACTS_MAX_AGE_MS_DEFAULT } from "../src/server.js";

// S3 §D — guards the D2 serve-time staleness ceiling default. A stale Tier-2 fact past this age is never
// quoted (money/NN#1 fail-honest); a silent revert to the pre-S3 1h default would let a stale price be
// quoted for up to an hour, so pin the value here rather than only in a diff.
describe("PRODUCT_FACTS_MAX_AGE_MS_DEFAULT — the 15-minute serve-time staleness ceiling default", () => {
  it("is 900_000 ms (15 minutes)", () => {
    expect(PRODUCT_FACTS_MAX_AGE_MS_DEFAULT).toBe(900_000);
  });
});
