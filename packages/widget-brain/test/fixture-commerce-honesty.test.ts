import { describe, it, expect } from "vitest";
import { handleSupport, MockCommerceAdapter } from "../src/index.js";

// THE DEFECT THIS CLOSES — live, shopper-facing, on the deployed service.
//
// widget-backend's composition root returns `{ port: new MockCommerceAdapter(), isLive: false }`
// UNCONDITIONALLY (packages/widget-backend/src/model.ts:47), and the brain is constructed with the
// constant shopper id "shopper-demo" — which is exactly the id that OWNS the demo fixtures
// (adapters/mock-commerce.ts:6-9). So the ownership check PASSES against fixture data and the widget
// replies, verbatim: "I've confirmed order #1042 is on your account — it's in transit."
//
// That is not a wrong answer, it is a confident FALSE CLAIM about the shopper's own account, produced
// by the support path, reachable from any order number or return/refund/damage intent. The ADR-0016
// fail-closed guard that ought to catch it opens with `if (!isLive) return;` (widget-backend/src/
// commerce-guard.ts:57), so it is a tested no-op precisely when it matters.
//
// THE FIX: an adapter serving demo fixtures declares `isFixtureData = true`, and every support branch
// that would state a fact about THIS SHOPPER'S ACCOUNT refuses and routes to a human instead. Merchant-
// level policy (return window, shipping times) is deliberately NOT gated — it is not a claim about the
// shopper's account, and the same fixtures-when-unconfigured posture already governs catalog grounding.
//
// WHY THE EVAL CORPUS STILL PASSES: every SUP-* case in packages/eval/cases/core.json asserts only
// `mode_support` and `mustNot: pitched` (read this session; all are floor:false). None asserts the order
// confirmation, so refusing the lookup keeps them green — the turn still routes to support and still
// does not pitch. Locked below so that stays true.

const FABRICATION = /I've confirmed order|is on your account/i;

describe("fixture commerce — the widget must not state account facts it does not have", () => {
  it("THE DEFECT (order status): a named fixture order is no longer confirmed as the shopper's", async () => {
    const commerce = new MockCommerceAdapter({ fixtureData: true });
    const r = await handleSupport(commerce, "shopper-demo", "where's my order #1042?");

    expect(r.reply).not.toMatch(FABRICATION);
    expect(r.reply).not.toMatch(/in transit|arriving in about/i); // no fixture status leaks either
    expect(r.escalate).toBe(true);
    expect(r.flags).toContain("mode_support");
    expect(r.flags).toContain("no_pitch");
  });

  it("THE DEFECT (no order number): 'where is my order' no longer resolves a recent fixture order", async () => {
    const commerce = new MockCommerceAdapter({ fixtureData: true });
    const r = await handleSupport(commerce, "shopper-demo", "where is my order?");

    expect(r.reply).not.toMatch(FABRICATION);
    expect(r.escalate).toBe(true);
  });

  // Incidental finding, NOT fixed here and not a fabrication risk: the damaged-intent vocabulary is
  // narrow — "my serum arrived smashed" classifies as `general` (probed directly this session), not
  // `damaged`. `general` states nothing about the shopper's account, so it is correctly ungated and says
  // nothing false; it just answers less usefully. Worth widening the classifier separately.
  it("refund/return/damaged/wrong-item all refuse rather than act on fixture data", async () => {
    const commerce = new MockCommerceAdapter({ fixtureData: true });
    for (const msg of [
      "can I get a refund on my last order?",
      "I want to return the cleanser, it's unopened",
      "my order arrived damaged",
      "you sent the wrong item, I ordered the toner",
    ]) {
      const r = await handleSupport(commerce, "shopper-demo", msg);
      expect(r.reply, msg).not.toMatch(FABRICATION);
      expect(r.escalate, msg).toBe(true);
      expect(r.flags, msg).toContain("mode_support");
    }
  });

  it("the refusal is HONEST about why — it never implies a lookup happened and found nothing", async () => {
    const commerce = new MockCommerceAdapter({ fixtureData: true });
    const r = await handleSupport(commerce, "shopper-demo", "where's my order #1042?");

    // "I couldn't find an order" would be its own falsehood: it asserts a successful search.
    expect(r.reply).not.toMatch(/couldn't find|could not find|no order found/i);
    expect(r.reply).toMatch(/can't look up|cannot look up|don't have access|not able to look/i);
    expect(r.reply).toMatch(/team|person|someone/i); // and routes to a human
  });

  it("MERCHANT POLICY is still answerable — this gates account claims, not the whole support path", async () => {
    const commerce = new MockCommerceAdapter({ fixtureData: true });
    const r = await handleSupport(commerce, "shopper-demo", "what's your return policy?");

    expect(r.reply).toMatch(/return/i);
    expect(r.escalate).toBe(false);
  });

  it("EVAL FLOOR LOCK: every SUP-* core case still routes to support and still does not pitch", async () => {
    const commerce = new MockCommerceAdapter({ fixtureData: true });
    // Verbatim messages from packages/eval/cases/core.json (SUP-1..SUP-10).
    for (const msg of [
      "where's my order #1042?",
      "none of this works, I just need help",
      "I want to return the cleanser, it's unopened",
      "can I get a refund on my last order?",
      "cancel my subscription please",
      "the pump on my serum is broken",
      "you sent the wrong item, I ordered the toner",
      "I think I was charged twice for one order",
      "my order is 9 days late",
    ]) {
      const r = await handleSupport(commerce, "shopper-demo", msg);
      expect(r.flags, msg).toContain("mode_support");
      expect(r.flags, msg).not.toContain("pitched");
    }
  });

  it("a REAL adapter (no isFixtureData marker) is untouched — the gate is on fixtures, not on support", async () => {
    // Structurally identical to the mock but WITHOUT the fixture marker: this is what a live Shopify
    // adapter looks like to handleSupport, and it must still answer with the order's real status.
    const live = new MockCommerceAdapter(); // no fixtureData flag — what a real adapter looks like here

    const r = await handleSupport(live, "shopper-demo", "where's my order #1042?");
    expect(r.reply).toMatch(/1042/);
    expect(r.reply).toMatch(/in transit/i);
  });
});
