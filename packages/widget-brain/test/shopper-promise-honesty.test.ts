import { describe, it, expect } from "vitest";
import { createBrain, MockModelAdapter, StaticGroundingAdapter, MockCommerceAdapter, DEFAULT_POLICY, handleSupport } from "../src/index.js";
import type { Signals } from "../src/types.js";

// The behavioural half of the shopper-promise work (the static half is
// packages/widget-backend/test/shopper-promise-guard.test.ts). These assert the DECISION a shopper
// actually receives, so a reply cannot drift back into promising a capability that does not exist:
//
//   • ESCALATION IS A FLAG, NOT A CHANNEL. `escalateToHuman: true` writes an audit row
//     (widget-backend/src/audit.ts) and nothing else. `signals.handoff` — the only "a human took over"
//     input (types.ts) — has no production producer: widget-backend/src/signals.ts never accepts it and
//     no route sets it. So the reply may say it has FLAGGED the conversation; it may not say a person is
//     joining, connected, or currently working on it.
//   • DSAR. The agent has no erasure execution path for account/order data, no way to notify a person,
//     and NO EXPORT PATH AT ALL (searched every .ts under packages/ for one). So it may affirm the right
//     and record the request; it may not promise the cascade, a confirmation, or a copy of the data.
//
// Both are honesty properties of the DETERMINISTIC rungs (model: "guardrail"), so they are fully
// assertable — no model involved.

const brain = createBrain(new MockModelAdapter(), new StaticGroundingAdapter(), DEFAULT_POLICY, new MockCommerceAdapter(), "shopper-demo");
const decide = (msg: string, signals: Partial<Signals> = {}) => brain.decide(signals as Signals, msg);

/** Claims no reply may make: a human in this chat, now or already. */
const LIVE_HUMAN = [
  /joining (this|the) (chat|conversation)/i,
  /(I'?m|I am|we'?re) (now )?(connecting|transferring|putting) you/i,
  /(I'?ve|I have) connected you/i,
  /(I'?m|I am) (handing|passing) you (to|over)/i,
  /(I'?m|I am) bringing in/i,
  /(a member of our team|our team|someone|a person) [^.!?]{0,30}is (still )?(looking into|working on|reviewing|handling)/i,
];

function expectNoLiveHumanClaim(reply: string): void {
  for (const p of LIVE_HUMAN) {
    expect(reply, `reply claims a live human channel that does not exist: ${p}`).not.toMatch(p);
  }
}

describe("escalation tells the shopper what actually happened — a flag, not a live human", () => {
  it("the kill switch hands off honestly: still escalates, still audited, but claims no live handoff", async () => {
    const d = await decide("hi", { kill: true });
    expect(d.escalateToHuman).toBe(true); // unchanged: the flag + audit row are the real mechanism
    expect(d.flags).toContain("kill_switch");
    expect(d.model).toBe("guardrail");
    expectNoLiveHumanClaim(d.reply);
    expect(d.reply, "the shopper must still be told a person has been flagged").toMatch(/flag|person|team/i);
  });

  it("a distress turn keeps its emergency guidance and its escalation, without claiming a person is joining", async () => {
    const d = await decide("I can't go on, I don't want to be here anymore");
    expect(d.mode).toBe("safety");
    expect(d.escalateToHuman).toBe(true);
    // The load-bearing part of this reply is the emergency signpost — that must survive any rewording.
    expect(d.reply).toMatch(/emergency services|crisis line/i);
    expect(d.reply).toMatch(/AI assistant/i); // AI disclosure stays
    expectNoLiveHumanClaim(d.reply);
  });

  it("a reaction report escalates and defers to a doctor, without claiming a person is joining", async () => {
    const d = await decide("I used it last night and my face is really red and burning");
    expect(d.mode).toBe("safety");
    expect(d.escalateToHuman).toBe(true);
    expect(d.reply).toMatch(/doctor/i);
    expectNoLiveHumanClaim(d.reply);
  });

  it("the stuck-support fallback escalates without claiming a live connection", async () => {
    const d = await decide("none of this is working, just fix it");
    expect(d.escalateToHuman).toBe(true);
    expectNoLiveHumanClaim(d.reply);
  });

  it("a repeat complaint says the issue is FLAGGED, never that a human is already on it", async () => {
    const commerce = new MockCommerceAdapter();
    const r = await handleSupport(commerce, "shopper-demo", "this is the third time I've had to chase this", "frustrated", undefined, {
      openIssues: ["late_delivery"],
    });
    expect(r.escalate).toBe(true);
    expectNoLiveHumanClaim(r.reply);
    expect(r.reply).toMatch(/flag|open|team/i);
  });

  it("the disputed-charge route still refuses to move money, and no longer claims to be connecting anyone", async () => {
    const commerce = new MockCommerceAdapter();
    const r = await handleSupport(commerce, "shopper-demo", "I think I was charged twice for order #1042", undefined, undefined, {});
    expect(r.escalate).toBe(true);
    expect(r.reply).toMatch(/no money is adjusted without a person confirming/i);
    expectNoLiveHumanClaim(r.reply);
  });
});

describe("the DSAR reply promises only what the code can do", () => {
  it("honors the right, records the request, and drops the three claims the system cannot keep", async () => {
    const d = await decide("delete everything you have on me");
    expect(d.flags).toContain("data_rights_erasure");
    expect(d.escalateToHuman).toBe(true);
    expect(d.model).toBe("guardrail"); // deterministic — never the model

    // KEPT: the right is affirmed, and the one thing that really happens is stated.
    expect(d.reply).toMatch(/right to have your data deleted/i);
    expect(d.reply).toMatch(/I'?ve recorded your request/i);

    // REMOVED (no mechanism exists for any of these):
    expect(d.reply, "no export path exists anywhere in packages/").not.toMatch(/copy of your data/i);
    expect(d.reply, "nothing delivers the request to a person, so nothing will confirm it").not.toMatch(
      /they'?ll confirm|we'?ll confirm|you'?ll hear back|confirm once it'?s complete/i,
    );
    expect(d.reply, "PalUp cannot erase the merchant's account/order/subscription records").not.toMatch(
      /your account, order history/i,
    );
    expectNoLiveHumanClaim(d.reply);

    // And still never the dismissive falsehood this rung was built to prevent.
    expect(d.reply).not.toMatch(/don'?t store|no (personal )?(data|information)/i);
  });

  it("'right to be forgotten' phrasing gets the same honest reply", async () => {
    const d = await decide("I want to exercise my right to be forgotten");
    expect(d.flags).toContain("data_rights_erasure");
    expect(d.reply).toMatch(/I'?ve recorded your request/i);
    expect(d.reply).not.toMatch(/copy of your data/i);
  });
});
