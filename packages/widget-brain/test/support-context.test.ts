import { describe, it, expect } from "vitest";
import { MockCommerceAdapter } from "../src/index.js";
import { handleSupport, classifySupportIntent, type SupportContext } from "../src/support.js";

// D1 (conversation-quality wave 1): the support handler is context-aware — it resumes an open issue,
// bridges a pending escalation, escalates a frustrated complaint, recalls an order named earlier, and
// closes warmly on a sign-off — instead of dead-ending on a generic "share your order number".

const commerce = new MockCommerceAdapter();
const call = (message: string, o: { mood?: string; context?: SupportContext } = {}) =>
  handleSupport(commerce, "shopper-demo", message, o.mood, { enabled: false, shopperVerified: false }, o.context);

describe("D1 — context-aware support fallback", () => {
  it("escalation_pending signal → bridge (a person is still coming), not a restart", async () => {
    const r = await call("while I wait, which moisturizer is better?", { context: { openIssues: ["escalation_pending"] } });
    expect(r.escalate).toBe(true);
    expect(r.reply).toMatch(/still (looking into|on)|team is|follow up|hang/i);
    expect(r.reply).not.toMatch(/share your order number/i);
  });

  it("an open issue on file → resumes it BY NAME, shows memory", async () => {
    const r = await call("hi", { context: { openIssues: ["shipping_issue"] } });
    expect(r.escalate).toBe(true);
    expect(r.reply).toMatch(/shipping issue/i);
    expect(r.reply).toMatch(/haven'?t forgotten|still have/i);
  });

  it("a frustrated shopper → acknowledge + escalate, never re-ask for info", async () => {
    const r = await call("(demands it be fixed)", { mood: "frustrated", context: { openIssues: ["order_status"] } });
    expect(r.escalate).toBe(true);
    expect(r.reply).not.toMatch(/tell me a bit more|share your order number/i);
  });

  it("a clear complaint (no mood signal) → acknowledge + escalate", async () => {
    const r = await call("your checkout keeps failing on me and I'm about to leave");
    expect(r.escalate).toBe(true);
    expect(r.reply).toMatch(/make it right|team|connected/i);
  });

  it("a sign-off → warm close, no escalation, no pitch", async () => {
    const r = await call("thanks, that's all");
    expect(r.escalate).toBe(false);
    expect(r.reply).toMatch(/you'?re welcome|glad/i);
    expect(r.flags).toContain("no_pitch");
  });

  it("an order named earlier in history → recalls it instead of re-asking which one", async () => {
    const r = await call("what about it?", { context: { history: [{ role: "user", content: "where's my order?" }, { role: "agent", content: "Order #1042 is in transit." }] } });
    expect(r.reply).toMatch(/#1042/);
    expect(r.reply).not.toMatch(/which order|share your order number/i);
  });

  it("no context + no signals → the original generic ask (unchanged floor)", async () => {
    const r = await call("hmm");
    expect(r.escalate).toBe(false);
    expect(r.reply).toMatch(/tell me a bit more|share your order number/i);
  });
});

describe("D4 — how_to no longer over-matches ambiguous efficacy questions", () => {
  it("an ambiguous 'does it work / how long till results' question is NOT how_to", () => {
    expect(classifySupportIntent("is this the better one and does it work and how long till i see results with the whole routine?")).not.toBe("how_to");
  });
  it("a genuine usage question still classifies as how_to", () => {
    expect(classifySupportIntent("how do I use the retinol?")).toBe("how_to");
    expect(classifySupportIntent("how often should I apply the serum?")).toBe("how_to");
  });
});

describe("D5 — above-ceiling refund with no named order → HITL + expectation", () => {
  it("a stated amount above the refund ceiling → route to a person + set the expectation", async () => {
    const r = await call("$180 order, refund it all");
    expect(r.flags).toContain("refund_hitl");
    expect(r.escalate).toBe(true);
    expect(r.reply).toMatch(/reviews? refunds|above the amount|\$180/i);
  });
  it("a small refund with no order still just asks which order (unchanged)", async () => {
    const r = await call("refund my $12 order");
    expect(r.flags).not.toContain("refund_hitl");
    expect(r.reply).toMatch(/which order/i);
  });
});
