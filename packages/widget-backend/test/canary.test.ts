import { describe, it, expect } from "vitest";
import { bucket } from "../src/canary.js";

describe("canary session bucket (sticky split)", () => {
  it("is deterministic per session and in [0,100)", () => {
    const b = bucket("session-abc");
    expect(b).toBe(bucket("session-abc")); // sticky — same session, same side
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(100);
  });
  it("spreads distinct sessions across buckets", () => {
    const buckets = new Set(Array.from({ length: 60 }, (_, i) => bucket(`s-${i}`)));
    expect(buckets.size).toBeGreaterThan(15); // not all colliding
  });
});
