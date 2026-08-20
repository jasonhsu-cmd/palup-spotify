import { describe, it, expect } from "vitest";
import { createBrain, MockModelAdapter, StaticGroundingAdapter, MockCommerceAdapter, DEFAULT_POLICY } from "../src/index.js";

// D3 (conversation-quality wave 1b): deterministic identity + data-rights rungs — a "delete my data"
// request is HONORED (never denied), and an anonymous shopper asking about their own orders is invited
// to sign in (never guessed at). Both run before the model, so a stronger model can't loosen them.

const brain = createBrain(new MockModelAdapter(), new StaticGroundingAdapter(), DEFAULT_POLICY, new MockCommerceAdapter(), "shopper-demo");
const decide = (msg: string, signals: Record<string, unknown> = {}) => brain.decide(signals as never, msg);

describe("D3 — identity + data-rights rungs", () => {
  it("erasure / DSAR request → honors it (logs + routes the cascade), never denies having data", async () => {
    const d = await decide("delete everything you have on me");
    expect(d.flags).toContain("data_rights_erasure");
    expect(d.escalateToHuman).toBe(true);
    expect(d.reply).toMatch(/right to have your data deleted|erase the personal data/i);
    expect(d.reply).not.toMatch(/don'?t store|no (personal )?(data|information)/i); // the failing behavior we fixed
    expect(d.model).toBe("guardrail"); // deterministic — never the model
  });

  it("'right to be forgotten' phrasing also triggers the erasure rung", async () => {
    const d = await decide("I want to exercise my right to be forgotten");
    expect(d.flags).toContain("data_rights_erasure");
  });

  it("anonymous shopper asks about their own orders → invite to sign in, no guess", async () => {
    const d = await decide("what did I order last time?", { relationship: "anonymous" });
    expect(d.flags).toContain("identity_required");
    expect(d.reply).toMatch(/sign in|signed in/i);
    expect(d.pitch).toBe("none");
    expect(d.model).toBe("guardrail");
  });

  it("an IDENTIFIED shopper asking about orders does NOT hit the sign-in rung (normal support)", async () => {
    const d = await decide("what did I order last time?", { relationship: "repeat" });
    expect(d.flags).not.toContain("identity_required");
  });

  it("an anonymous shopper WITH an order number → NOT the sign-in rung (the number is lookup-able; IDOR is the commerce-guard's job)", async () => {
    const d = await decide("where's my order #1042?", { relationship: "anonymous" });
    expect(d.flags).not.toContain("identity_required");
  });
});

// F12 — the identity-required guard's own-order regex matches a BARE "my order" with no complaint
// context. That is correct for a genuine status lookup ("where's my order?"), but it also swallowed a
// genuine service complaint that happens to say "my order" ("this is the third time my order has been
// wrong and I'm really frustrated"), short-circuiting straight to the cold sign-in script with zero
// acknowledgment of the complaint/emotion (docs/widget-test-report.md F12, L2-05). Fix: when the SAME
// message also carries a complaint/frustration signal (support.ts's existing annoyance detector — the
// identical regex handleSupport already uses to prefix an empathy line), the identity-gate reply
// acknowledges that before the sign-in ask. The gate itself — never guessing at an unverified account,
// never doing a real lookup — is unchanged either way (that part is the actual security property).
describe("F12 — the identity gate acknowledges a complaint riding along with 'my order', not just routes it", () => {
  it("a complaint that also says 'my order' gets empathy, not the bare word-for-word lookup script", async () => {
    const d = await decide(
      "This is the third time my order has been wrong and I'm really frustrated",
      { relationship: "anonymous" },
    );
    expect(d.flags).toContain("identity_required"); // still can't guess the account — unchanged
    expect(d.pitch).toBe("none");
    expect(d.model).toBe("guardrail"); // still deterministic, no model call
    // The actual defect: acknowledges the frustration instead of reading as a routine lookup.
    expect(d.reply).toMatch(/sorry|frustrat/i);
    // Must not be the OLD bare script verbatim (that had zero acknowledgment of the complaint).
    expect(d.reply).not.toBe(
      "I'd love to pull that up, but I can't see your order history unless you're signed in — I don't want to guess about your account. If you sign in (or share your order number), I can look it up right away. In the meantime I'm glad to help with anything about our products.",
    );
  });

  it("a BARE order-status lookup with no complaint signal is completely unchanged (regression guard)", async () => {
    const d = await decide("where's my order?", { relationship: "anonymous" });
    expect(d.flags).toContain("identity_required");
    expect(d.reply).toBe(
      "I'd love to pull that up, but I can't see your order history unless you're signed in — I don't want to guess about your account. If you sign in (or share your order number), I can look it up right away. In the meantime I'm glad to help with anything about our products.",
    );
  });

  it("'what did I order last time?' with no complaint signal stays the original bare script too", async () => {
    const d = await decide("what did I order last time?", { relationship: "anonymous" });
    expect(d.reply).toMatch(/sign in|signed in/i);
    expect(d.reply).not.toMatch(/sorry|frustrat/i);
  });
});
