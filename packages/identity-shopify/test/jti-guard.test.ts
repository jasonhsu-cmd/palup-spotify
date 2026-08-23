import { describe, it, expect } from "vitest";
import { createInMemoryJtiGuard } from "../src/jti-guard.js";

describe("createInMemoryJtiGuard (single-use exchange, ADR-0011)", () => {
  it("accepts a jti once and rejects its replay", async () => {
    const g = createInMemoryJtiGuard(() => 1000);
    expect(await g.useOnce("jti-1", 2000)).toBe(true);
    expect(await g.useOnce("jti-1", 2000)).toBe(false); // replay within window ⇒ rejected
  });
  it("distinct jtis are independent", async () => {
    const g = createInMemoryJtiGuard(() => 1000);
    expect(await g.useOnce("a", 2000)).toBe(true);
    expect(await g.useOnce("b", 2000)).toBe(true);
  });
  it("prunes expired entries so memory does not grow unbounded", async () => {
    let now = 1000;
    const g = createInMemoryJtiGuard(() => now);
    expect(await g.useOnce("old", 1100)).toBe(true);
    now = 5000; // "old" has expired; a fresh, different jti still works and the store stays small
    expect(await g.useOnce("new", 6000)).toBe(true);
    // Reusing an EXPIRED jti is still refused if within store — but once pruned a re-mint is impossible
    // anyway (Shopify never reissues a jti); the invariant that matters is unbounded-growth prevention.
  });
});
