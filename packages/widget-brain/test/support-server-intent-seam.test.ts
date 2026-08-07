import { describe, it, expect } from "vitest";
import { handleSupport, MockCommerceAdapter } from "../src/index.js";

// T1 phase 3 — the handleSupport server-intent seam. A server-derived support intent (from the
// language-agnostic guard classifier) OVERRIDES the internal English classifier, so a non-English
// support request reaches the right deterministic handler. Absent ⇒ byte-identical (English classify).
// The producing classifier + server wiring (broaden + threading) is the next increment; here we pin the
// seam deterministically by passing the intent directly.

describe("handleSupport — server-intent seam", () => {
  const commerce = new MockCommerceAdapter();

  it("uses the server-derived intent when provided (overrides the internal English classify)", async () => {
    // "hi there" classifies internally as "general"; a server intent of "return" must win.
    const r = await handleSupport(commerce, "shopper-demo", "hi there", undefined, undefined, undefined, "return");
    expect(r.flags).toContain("support:return");
    expect(r.flags).not.toContain("support:general");
  });

  it("falls back to the internal classifier when no server intent is given (byte-identical)", async () => {
    const withSeam = await handleSupport(commerce, "shopper-demo", "hi there", undefined, undefined, undefined, undefined);
    const withoutArg = await handleSupport(commerce, "shopper-demo", "hi there");
    expect(withSeam).toEqual(withoutArg); // passing undefined is identical to not passing it
    expect(withoutArg.flags).toContain("support:general");
  });
});
