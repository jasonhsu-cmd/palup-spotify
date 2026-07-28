import { describe, it, expect } from "vitest";
import { MockCommerceAdapter, handleSupport, classifySupportIntent, extractOrderId } from "../src/index.js";

const c = new MockCommerceAdapter();
const shopper = "shopper-demo";

describe("support intent classification", () => {
  it("classifies the main intents", () => {
    expect(classifySupportIntent("where's my order #1042?")).toBe("order_status");
    expect(classifySupportIntent("cancel my subscription")).toBe("cancel_subscription");
    expect(classifySupportIntent("I'd like a refund")).toBe("refund");
    expect(classifySupportIntent("the pump is broken")).toBe("damaged");
    expect(classifySupportIntent("what's your return window?")).toBe("policy_q");
    expect(classifySupportIntent("none of this works, I just need help")).toBe("escalate_stuck");
  });
  it("does not read a price as an order id", () => {
    expect(extractOrderId("refund my $180 order #2000")).toBe("2000");
    expect(extractOrderId("where's my order #1042?")).toBe("1042");
  });
});

describe("support guardrails (in code)", () => {
  it("verifies ownership before revealing another shopper's order", async () => {
    const r = await handleSupport(c, shopper, "status of order #9999?");
    expect(r.flags).toContain("ownership_denied");
    expect(r.escalate).toBe(true);
    expect(r.reply.toLowerCase()).not.toContain("delivered");
  });
  it("grounds an owned order's status, no fabrication", async () => {
    const r = await handleSupport(c, shopper, "where's my order #1042?");
    expect(r.reply).toContain("#1042");
    expect(r.reply).toMatch(/in transit/);
  });
  it("routes a refund above the ceiling to a human (never auto-approves)", async () => {
    const r = await handleSupport(c, shopper, "refund my $180 order #2000");
    expect(r.flags).toContain("refund_hitl");
    expect(r.escalate).toBe(true);
    expect(r.reply).toMatch(/route|team member|person/i);
  });
  it("processes a refund within the ceiling without escalating", async () => {
    const r = await handleSupport(c, shopper, "refund order #1050");
    expect(r.flags).toContain("refund_within_ceiling");
    expect(r.escalate).toBe(false);
  });
  it("won't silently cancel an already-shipped order", async () => {
    const r = await handleSupport(c, shopper, "cancel my order #1042");
    expect(r.escalate).toBe(true);
    expect(r.reply).toMatch(/already shipped/i);
  });
  it("cancels a not-yet-shipped order", async () => {
    const r = await handleSupport(c, shopper, "cancel my order #3100");
    expect(r.reply).toMatch(/cancelled/i);
    expect(r.escalate).toBe(false);
  });
  it("honors a subscription cancel immediately (no dark pattern)", async () => {
    const r = await handleSupport(c, shopper, "cancel my subscription");
    expect(r.reply).toMatch(/cancelled/i);
    expect(r.reply).toMatch(/immediately/i);
  });
  it("escalates when the shopper is stuck, never pitches", async () => {
    const r = await handleSupport(c, shopper, "none of this works, I just need help");
    expect(r.escalate).toBe(true);
    expect(r.flags).toContain("no_pitch");
  });
});
