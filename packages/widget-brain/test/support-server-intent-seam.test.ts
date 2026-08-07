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

  // broaden — THE SECURITY DEMONSTRATION (#247). The server intent is UNTRUSTED-input-derived (a model
  // read of a shopper message in any language). It must only ROUTE; it must never AUTHORIZE a
  // money/subscription action. Even when the classifier says "skip"/"cancel", the action stays gated.
  describe("a classifier-derived subscription intent ROUTES but never auto-executes", () => {
    it("skip_subscription without the two ADR-0016 controls (no selfServe, unverified) routes to a human — no auto-skip", async () => {
      // Message the internal classifier would NOT route to skip ("hi there") — so the ONLY thing asking
      // for a skip is the (untrusted) server intent. It must still not skip.
      const r = await handleSupport(commerce, "shopper-demo", "hi there", undefined, undefined, undefined, "skip_subscription");
      expect(r.escalate).toBe(true);
      expect(r.flags).toContain("skip_sub_routed"); // routed to a person, not executed
      expect(r.reply).toMatch(/member of our team|passed your request/i);
      expect(r.reply).not.toMatch(/I['’]ve skipped|skipped your|done|applied the skip/i); // never claims it acted
    });

    it("cancel_subscription from the server intent is flagged for human finalization — we never claim WE cancelled", async () => {
      const r = await handleSupport(commerce, "shopper-demo", "hi there", undefined, undefined, undefined, "cancel_subscription");
      expect(r.escalate).toBe(true);
      expect(r.flags).toContain("cancel_sub_routed");
      expect(r.reply).toMatch(/flagged it for a member of our team|team to finalize/i);
    });

    it("a forged server intent behaves IDENTICALLY to the same keyword intent — routing, not a new authority", async () => {
      // Same gated outcome whether the skip intent came from the classifier or the English keyword floor:
      // the seam changed WHO named the intent, never what an intent is allowed to do.
      const viaServer = await handleSupport(commerce, "shopper-demo", "please skip my next delivery", undefined, undefined, undefined, "skip_subscription");
      const viaKeyword = await handleSupport(commerce, "shopper-demo", "please skip my next delivery");
      expect(viaServer.escalate).toBe(viaKeyword.escalate);
      expect(viaServer.flags).toContain("skip_sub_routed");
      expect(viaKeyword.flags).toContain("skip_sub_routed");
    });
  });
});
