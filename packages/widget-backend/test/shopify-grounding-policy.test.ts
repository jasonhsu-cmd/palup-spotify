import { describe, it, expect } from "vitest";
import { boundWords } from "../src/shopify-grounding.js";

describe("boundWords", () => {
  it("returns the string unchanged when under the cap", () => {
    expect(boundWords("short policy", 100)).toBe("short policy");
  });
  it("truncates on a word boundary with an ellipsis, never mid-word", () => {
    // Exact expected string, not just shape assertions — a naive `slice(0, max) + "…"` with no
    // word-boundary logic (e.g. "free shipping over fifty dolla…") would also satisfy
    // endsWith("…") and length<=31, so this must pin the precise word-bounded cut.
    expect(boundWords("free shipping over fifty dollars treat yourself basically", 30)).toBe(
      "free shipping over fifty…"
    );
  });
});
