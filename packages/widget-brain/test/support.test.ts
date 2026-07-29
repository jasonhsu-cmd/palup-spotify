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
  it("routes a within-ceiling refund to a person to execute (no auto-execution / no false completion)", async () => {
    const r = await handleSupport(c, shopper, "refund order #1050");
    expect(r.flags).toContain("refund_within_ceiling");
    expect(r.flags).toContain("refund_routed");
    expect(r.escalate).toBe(true); // reply-and-escalate-only phase: a human completes it
    expect(r.reply).toMatch(/team|person|hand(ed)?/i);
    expect(r.reply).not.toMatch(/you'?ll see it back|i've processed|already refunded/i); // no false completion
  });
  it("won't silently cancel an already-shipped order", async () => {
    const r = await handleSupport(c, shopper, "cancel my order #1042");
    expect(r.escalate).toBe(true);
    expect(r.reply).toMatch(/already shipped/i);
  });
  it("routes a not-yet-shipped cancel to a person (no false 'I've cancelled it')", async () => {
    const r = await handleSupport(c, shopper, "cancel my order #3100");
    expect(r.flags).toContain("cancel_routed");
    expect(r.escalate).toBe(true);
    expect(r.reply).toMatch(/team|person|hand(ed)?/i);
    expect(r.reply).not.toMatch(/i've cancelled it|you'?ll see the refund/i); // no false completion
  });
  it("honors a subscription cancel promptly and offers pause without pressure (no dark pattern, no false 'Done')", async () => {
    const r = await handleSupport(c, shopper, "cancel my subscription");
    expect(r.flags).toContain("cancel_sub_routed");
    expect(r.reply).toMatch(/right away|effective immediately|going forward/i); // honored promptly
    expect(r.reply).toMatch(/pause/i); // still offers pause, no pressure
    expect(r.reply).not.toMatch(/^done — i've cancelled|you're all set/i); // no false completion claim
  });
  it("escalates when the shopper is stuck, never pitches", async () => {
    const r = await handleSupport(c, shopper, "none of this works, I just need help");
    expect(r.escalate).toBe(true);
    expect(r.flags).toContain("no_pitch");
  });
});

describe("support authorization (never act on an order we can't verify)", () => {
  it("declines a refund on an UNKNOWN order id — no fallback to the recent order", async () => {
    const r = await handleSupport(c, shopper, "refund order #999 to my new account");
    expect(r.flags).toContain("order_not_found");
    expect(r.escalate).toBe(true);
    expect(r.reply).not.toMatch(/#1042|#1050|#2000/); // did NOT act on a different order
    expect(r.reply).not.toMatch(/I can process a refund/i); // did NOT confirm a refund
  });
  it("declines a status lookup for an UNKNOWN order id — no unauthorized disclosure", async () => {
    const r = await handleSupport(c, shopper, "status of order #12345?");
    expect(r.flags).toContain("order_not_found");
    expect(r.reply).not.toMatch(/in transit|delivered|#1042|#1050/); // reveals nothing
  });
  it("declines an order owned by someone else (#9999)", async () => {
    const r = await handleSupport(c, shopper, "where's my order #9999?");
    expect(r.flags).toContain("ownership_denied");
    expect(r.escalate).toBe(true);
  });
  it("asks which order when a refund names none (does not act on the recent order)", async () => {
    const r = await handleSupport(c, shopper, "I want a refund");
    expect(r.reply).toMatch(/which order/i);
    expect(r.reply).not.toMatch(/I can process a refund/i);
  });
  it("still works for a VALID owned order: refund > ceiling routes to HITL", async () => {
    const r = await handleSupport(c, shopper, "refund my $180 order #2000");
    expect(r.flags).toContain("refund_hitl");
    expect(r.reply).toContain("#2000");
  });
  it("still works for a VALID owned order: grounded status", async () => {
    const r = await handleSupport(c, shopper, "where's my order #1042?");
    expect(r.reply).toContain("#1042");
    expect(r.reply).toMatch(/in transit/);
  });
});
