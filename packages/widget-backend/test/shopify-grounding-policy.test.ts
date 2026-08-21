import { describe, it, expect } from "vitest";
import { boundWords } from "../src/shopify-grounding.js";

describe("boundWords", () => {
  it("returns the string unchanged when under the cap", () => {
    expect(boundWords("short policy", 100)).toBe("short policy");
  });
  it("truncates on a word boundary with an ellipsis, never mid-word", () => {
    const out = boundWords("free shipping over fifty dollars treat yourself basically", 30);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/basical…$/); // no mid-word cut
    expect(out.length).toBeLessThanOrEqual(31);
    expect(out.slice(0, -1).trim().split(" ").pop()).not.toBe("basical");
  });
});
