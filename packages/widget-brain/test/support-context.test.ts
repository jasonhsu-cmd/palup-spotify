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

// D1b (conversation-quality wave 1c): compound two-issue tracking, damage-refund empathy, honoring a
// re-affirmed cancel without stalling, and sign-off precision (a "thanks, but also…" is not a close).
describe("D1b — compound issues, damage-refund empathy, cancel honoring, sign-off precision", () => {
  // SUP-06 — a refund request that names damage ("the serum leaked") must empathize, note no proof
  // needed, frame the (within-policy) refund path, and flag a duplicate-charge check — not a cold ask.
  it("a refund for a leaked/damaged item → empathy + duplicate-check + drafted path (not a cold 'which order')", async () => {
    const r = await call("the serum leaked — refund", { context: { openIssues: ["damaged"] } });
    expect(r.reply).toMatch(/sorry|apolog/i); // empathize
    expect(r.reply).toMatch(/duplicate|no .*(double|extra) charge/i); // duplicate-check
    expect(r.reply).toMatch(/within our policy|flagged (it|this)|complete (it|the refund)/i); // within-ceiling / drafted
    expect(r.escalate).toBe(true);
  });
  it("a plain refund with no damage cue is unchanged (still asks which order, no false empathy)", async () => {
    const r = await call("I'd like a refund");
    expect(r.reply).toMatch(/which order/i);
  });

  // SW-9 — a compound "damaged AND other order late" must track BOTH issues, not just the damage.
  it("a compound 'damaged AND other order is late' → acknowledges BOTH issues", async () => {
    const r = await call("my serum pump is broken AND my other order is late.");
    expect(r.reply).toMatch(/damaged|replacement|refund/i); // issue 1
    expect(r.reply).toMatch(/other order|another order|running late|second (issue|order)|also.*late/i); // issue 2 tracked
    expect(r.escalate).toBe(true);
  });
  // SW-9 turn 2 — resuming open issues reads humanized (not "your defective open") and names both.
  it("resuming multiple open issues reads as 'damaged item' + 'shipping issue', never 'your defective open'", async () => {
    const r = await call("while we sort this, can I reorder the cleanser?", { context: { openIssues: ["defective", "shipping_issue"] } });
    expect(r.reply).not.toMatch(/your defective open/i);
    expect(r.reply).toMatch(/damaged item/i);
    expect(r.reply).toMatch(/shipping issue/i);
  });

  // GS-2 — an explicit cancel is honored immediately, no guilt-trip.
  it("an explicit subscription cancel honors immediately and doesn't guilt-trip", async () => {
    const r = await call("cancel my subscription.");
    expect(r.reply).not.toMatch(/sorry to see you go/i); // guilt phrasing removed
    expect(r.reply).toMatch(/right away|get (that|the cancellation) started|honou?r/i);
    expect(r.flags).toContain("cancel_sub_routed");
  });
  // GS-2 turn 2 — a re-affirmed cancel ("no, cancel.") is HONORED, not stalled with "hang in there".
  it("a re-affirmed cancel ('no, cancel.') with a subscription in flight is honored, not stalled", async () => {
    const r = await call("no, cancel.", { context: { openIssues: ["subscription"] } });
    expect(r.escalate).toBe(true);
    expect(r.reply).toMatch(/cancel/i);
    expect(r.reply).not.toMatch(/hang(ing)? in there|still looking into|keep (you )?waiting/i); // no obstruction
    expect(r.flags).toContain("cancel_sub_routed");
  });

  // SW-7 — "thanks — I also want to reorder…" is NOT a sign-off (it carries a follow-on request).
  it("'thanks — I also want to reorder the cleanser' is NOT swallowed as a sign-off", async () => {
    const r = await call("thanks — I also want to reorder the cleanser.");
    expect(r.reply).not.toMatch(/glad I could help/i); // not the warm-close
  });
  it("a pure 'thanks, that's all' still closes warmly (unchanged)", async () => {
    const r = await call("thanks, that's all");
    expect(r.reply).toMatch(/you'?re welcome|glad/i);
    expect(r.flags).toContain("no_pitch");
  });
});

// D1c (conversation-quality wave 1c-follow) — context-aware turn-2 follow-ups the single-intent handler
// dropped: confirming a full refund per policy on the in-context order (GS-1), and arranging a
// replacement the shopper accepts after a damaged-item offer (GS-3). Both stay honest (policy statement
// / teammate-executed) — no money moved, no shipment claimed as done.
describe("D1c — refund-eligibility answer + replacement acceptance", () => {
  const returnHistory = [
    { role: "user" as const, content: "I want to return the cleanser I bought last week, it's unopened." },
    { role: "agent" as const, content: "I've confirmed order #1042 is on your account; it was placed 3 days ago, within our 30-day window — I can start the return and email a prepaid label. Want me to go ahead?" },
  ];

  it("a refund-eligibility question after a return in progress → confirms a FULL refund per policy on the in-context order (GS-1)", async () => {
    const r = await call("great, do I get a full refund?", { context: { openIssues: ["returns"], history: returnHistory } });
    expect(r.reply).toMatch(/full(y)? refund|refunded in full|fully refundable/i);
    expect(r.reply).not.toMatch(/which order/i);
    expect(r.reply).toMatch(/#1042|30-day|window/i); // grounded on the in-context order / policy
  });
  it("a bare refund question with NO prior order still asks which order (unchanged)", async () => {
    const r = await call("do I get a refund?");
    expect(r.reply).toMatch(/which order/i);
  });

  it("accepting a replacement after a damaged-item offer → arranges it, not a generic escalation (GS-3)", async () => {
    const r = await call("just send a new one.", { mood: "frustrated", context: { openIssues: ["defective"] } });
    expect(r.reply).toMatch(/replacement|send a new one|new one/i);
    expect(r.reply).not.toMatch(/look into this|connected you with a member of our team/i); // not the generic complaint escalation
    expect(r.escalate).toBe(true);
    expect(r.flags).toContain("replacement_routed");
  });
  it("a replacement-acceptance phrase WITHOUT a damaged issue open does not fire (no false arrange)", async () => {
    const r = await call("just send a new one.");
    expect(r.flags).not.toContain("replacement_routed");
  });
});
