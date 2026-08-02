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
