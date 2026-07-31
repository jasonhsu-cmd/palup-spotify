import { describe, it, expect } from "vitest";
import { SUBSCRIPTION_SKIP_CAP } from "@palup/platform-ports";
import { createBrain, DEFAULT_POLICY, MockModelAdapter, StaticGroundingAdapter, MockCommerceAdapter, handleSupport, classifySupportIntent } from "../src/index.js";

// ADR-0016 enactment — prerequisites #2-#6 + the gated execution, now that #1 (verified shopper
// identity, ADR-0017 #99) is merged. "Verified" == signals.shopperId !== undefined (deriveServingSignals
// gates it on a server-verified principal) — brain.ts derives shopperVerified from exactly that, never
// from the shopperId STRING, so these tests exercise the boolean directly at the support.ts seam and
// end-to-end through brain.decide().

const shopper = "shopper-demo";

describe("ADR-0016 #6 — SUBSCRIPTION_SELFSERVE flag OFF ⇒ byte-identical human-routed behavior", () => {
  it("flag OFF routes exactly like calling handleSupport with no selfServe option at all, even for a verified shopper", async () => {
    const c = new MockCommerceAdapter();
    const withFlagOff = await handleSupport(c, shopper, "skip my next delivery", undefined, { enabled: false, shopperVerified: true });
    const withNoOptionAtAll = await handleSupport(c, shopper, "skip my next delivery"); // today's exact call shape
    expect(withFlagOff.escalate).toBe(true);
    expect(withFlagOff.flags).toContain("skip_sub_routed");
    expect(withFlagOff.reply).toBe(withNoOptionAtAll.reply); // byte-identical
    expect(withFlagOff.flags).not.toContain("sub_skipped");
    expect(withFlagOff.flags).not.toContain("autonomous_action");
  });
});

describe("ADR-0016 #1/#2 — gated on a server-VERIFIED shopper, never the shopperId string", () => {
  it("verified + flag ON ⇒ auto-executes the skip, confirms, does not escalate", async () => {
    const c = new MockCommerceAdapter();
    const r = await handleSupport(c, shopper, "skip my next delivery", undefined, { enabled: true, shopperVerified: true });
    expect(r.escalate).toBe(false);
    expect(r.flags).toContain("sub_skipped");
    expect(r.flags).toContain("autonomous_action");
    expect(r.flags).toContain("reversal:unskipNextDelivery");
    expect(r.reply.toLowerCase()).toContain("done");
    expect(r.reply.toLowerCase()).toContain("undo");
    const sub = await c.getSubscription(shopper);
    expect(sub?.nextDeliverySkipped).toBe(true);
    expect(sub?.consecutiveSkips).toBe(1);
  });

  it("unverified shopper + flag ON ⇒ still routes to a human (no autonomous_action) — this is exactly the eval-theater gap ADR-0016 forbids faking", async () => {
    const c = new MockCommerceAdapter();
    const r = await handleSupport(c, shopper, "skip my next delivery", undefined, { enabled: true, shopperVerified: false });
    expect(r.escalate).toBe(true);
    expect(r.flags).toContain("skip_sub_routed");
    expect(r.flags).not.toContain("sub_skipped");
    expect(r.flags).not.toContain("autonomous_action");
    const sub = await c.getSubscription(shopper);
    expect(sub?.nextDeliverySkipped).toBe(false); // nothing actually mutated
  });

  it("brain.decide derives verified from signals.shopperId !== undefined, never from the shopperId string", async () => {
    // Constructor default "shopper-demo" simulates a stale/shared brain instance (mirrors
    // brain-shopper-identity.test.ts) — it must NEVER be treated as verified on its own.
    const commerceAnon = new MockCommerceAdapter();
    const brainOn = createBrain(new MockModelAdapter(), new StaticGroundingAdapter(), DEFAULT_POLICY, commerceAnon, "shopper-demo", undefined, true);
    const anonDecision = await brainOn.decide({ tenantId: "demo" }, "skip my next delivery"); // no signals.shopperId at all
    expect(anonDecision.flags).not.toContain("sub_skipped");
    expect(anonDecision.escalateToHuman).toBe(true);

    const commerceVerified = new MockCommerceAdapter();
    const brainOn2 = createBrain(new MockModelAdapter(), new StaticGroundingAdapter(), DEFAULT_POLICY, commerceVerified, "shopper-demo", undefined, true);
    const verifiedDecision = await brainOn2.decide({ tenantId: "demo", shopperId: "shopper-demo" }, "skip my next delivery");
    expect(verifiedDecision.flags).toContain("sub_skipped");
    expect(verifiedDecision.escalateToHuman).toBe(false);
  });
});

describe("ADR-0016 #4 — skip cap: repeated skips can't become a stealth cancel", () => {
  it("cap reached ⇒ routes to a human instead of auto-skipping again", async () => {
    const c = new MockCommerceAdapter();
    c.seedSubscriptionState(shopper, { consecutiveSkips: SUBSCRIPTION_SKIP_CAP });
    const r = await handleSupport(c, shopper, "skip my next delivery", undefined, { enabled: true, shopperVerified: true });
    expect(r.escalate).toBe(true);
    expect(r.flags).toContain("skip_cap_reached");
    expect(r.flags).not.toContain("sub_skipped");
    expect(r.flags).not.toContain("autonomous_action");
    expect(r.reply.toLowerCase()).toMatch(/person|team/);
  });

  it("under the cap (cap - 1) ⇒ still auto-executes", async () => {
    const c = new MockCommerceAdapter();
    c.seedSubscriptionState(shopper, { consecutiveSkips: SUBSCRIPTION_SKIP_CAP - 1 });
    const r = await handleSupport(c, shopper, "skip my next delivery", undefined, { enabled: true, shopperVerified: true });
    expect(r.escalate).toBe(false);
    expect(r.flags).toContain("sub_skipped");
  });

  it("the port itself refuses a NEW skip past the cap too (defense-in-depth, independent of support.ts)", async () => {
    const c = new MockCommerceAdapter();
    c.seedSubscriptionState(shopper, { consecutiveSkips: SUBSCRIPTION_SKIP_CAP, nextDeliverySkipped: false });
    const result = await c.skipNextDelivery(shopper);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/cap/i);
  });
});

describe("ADR-0016 #5 — affirmative-intent tightening (negations/questions never auto-execute)", () => {
  it("a negation (\"please DON'T skip my next delivery\") never auto-executes", async () => {
    const c = new MockCommerceAdapter();
    const r = await handleSupport(c, shopper, "please DON'T skip my next delivery", undefined, { enabled: true, shopperVerified: true });
    expect(r.escalate).toBe(true);
    expect(r.flags).not.toContain("sub_skipped");
    expect(r.flags).not.toContain("autonomous_action");
    const sub = await c.getSubscription(shopper);
    expect(sub?.nextDeliverySkipped).toBe(false);
  });

  it("a retrospective question (\"WHY DID you skip my delivery\") never auto-executes", async () => {
    const c = new MockCommerceAdapter();
    const r = await handleSupport(c, shopper, "WHY DID you skip my delivery", undefined, { enabled: true, shopperVerified: true });
    expect(r.escalate).toBe(true);
    expect(r.flags).not.toContain("sub_skipped");
    expect(r.flags).not.toContain("autonomous_action");
  });

  it("a retrospective yes/no question (\"DID you skip my delivery?\") never auto-executes", async () => {
    const c = new MockCommerceAdapter();
    const r = await handleSupport(c, shopper, "DID you skip my delivery?", undefined, { enabled: true, shopperVerified: true });
    expect(r.escalate).toBe(true);
    expect(r.flags).not.toContain("sub_skipped");
    expect(r.flags).not.toContain("autonomous_action");
  });

  it("a genuine affirmative request phrased as a question (\"can I skip next month?\") still auto-executes (not every question is excluded, only past-tense/negated ones)", async () => {
    const c = new MockCommerceAdapter();
    const r = await handleSupport(c, shopper, "can I skip next month?", undefined, { enabled: true, shopperVerified: true });
    expect(r.escalate).toBe(false);
    expect(r.flags).toContain("sub_skipped");
  });
});

describe("ADR-0016 #3 — executable reversal (pause/resume, skip/unskip) — a real, callable capability", () => {
  it("pause auto-executes indefinitely, is flagged, and resumeSubscription genuinely reverses it", async () => {
    const c = new MockCommerceAdapter();
    const r = await handleSupport(c, shopper, "please pause my subscription", undefined, { enabled: true, shopperVerified: true });
    expect(r.escalate).toBe(false);
    expect(r.flags).toContain("sub_paused");
    expect(r.flags).toContain("indefinite_pause");
    expect(r.flags).toContain("autonomous_action");
    expect(r.flags).toContain("reversal:resumeSubscription");
    let sub = await c.getSubscription(shopper);
    expect(sub?.paused).toBe(true);
    const resumed = await c.resumeSubscription(shopper);
    expect(resumed.ok).toBe(true);
    sub = await c.getSubscription(shopper);
    expect(sub?.paused).toBe(false);
  });

  it("a shopper-reachable resume request auto-executes through the SAME handler (the promise 'you can undo this' is a real chat path, not just a port method)", async () => {
    const c = new MockCommerceAdapter();
    await c.pauseSubscription(shopper);
    const r = await handleSupport(c, shopper, "please resume my subscription", undefined, { enabled: true, shopperVerified: true });
    expect(r.escalate).toBe(false);
    expect(r.flags).toContain("sub_resumed");
    expect(r.flags).toContain("reversal:pauseSubscription");
    const sub = await c.getSubscription(shopper);
    expect(sub?.paused).toBe(false);
  });

  it("skip auto-executes and unskipNextDelivery genuinely reverses it", async () => {
    const c = new MockCommerceAdapter();
    await handleSupport(c, shopper, "skip my next delivery", undefined, { enabled: true, shopperVerified: true });
    let sub = await c.getSubscription(shopper);
    expect(sub?.nextDeliverySkipped).toBe(true);
    expect(sub?.consecutiveSkips).toBe(1);
    const undone = await c.unskipNextDelivery(shopper);
    expect(undone.ok).toBe(true);
    sub = await c.getSubscription(shopper);
    expect(sub?.nextDeliverySkipped).toBe(false);
    expect(sub?.consecutiveSkips).toBe(0);
  });

  it("a shopper-reachable 'undo the skip' request auto-executes unskipNextDelivery through the SAME handler", async () => {
    const c = new MockCommerceAdapter();
    await c.skipNextDelivery(shopper);
    const r = await handleSupport(c, shopper, "please undo the skip on my next delivery", undefined, { enabled: true, shopperVerified: true });
    expect(r.escalate).toBe(false);
    expect(r.flags).toContain("sub_skip_undone");
    expect(r.flags).toContain("reversal:skipNextDelivery");
    const sub = await c.getSubscription(shopper);
    expect(sub?.nextDeliverySkipped).toBe(false);
  });
});

describe("ADR-0016 #4 — idempotency: a repeated identical skip is a no-op, never a double-skip", () => {
  it("calling skipNextDelivery twice in a row only counts once", async () => {
    const c = new MockCommerceAdapter();
    const first = await c.skipNextDelivery(shopper);
    const second = await c.skipNextDelivery(shopper);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true); // still succeeds — a no-op, not an error
    const sub = await c.getSubscription(shopper);
    expect(sub?.consecutiveSkips).toBe(1); // NOT 2
  });

  it("a repeated identical skip REQUEST through handleSupport is idempotent too", async () => {
    const c = new MockCommerceAdapter();
    const r1 = await handleSupport(c, shopper, "skip my next delivery", undefined, { enabled: true, shopperVerified: true });
    const r2 = await handleSupport(c, shopper, "skip my next delivery", undefined, { enabled: true, shopperVerified: true });
    expect(r1.flags).toContain("sub_skipped");
    expect(r2.flags).toContain("sub_skipped"); // still confirms — no error, no double action
    const sub = await c.getSubscription(shopper);
    expect(sub?.consecutiveSkips).toBe(1);
  });
});

describe("cancel_subscription stays UNCHANGED — always human-routed, never auto-executed", () => {
  it("cancel is human-routed even with the flag on AND a verified shopper", async () => {
    const c = new MockCommerceAdapter();
    const r = await handleSupport(c, shopper, "cancel my subscription", undefined, { enabled: true, shopperVerified: true });
    expect(r.escalate).toBe(true);
    expect(r.flags).toContain("cancel_sub_routed");
    expect(r.flags).not.toContain("autonomous_action");
    expect(r.flags).not.toContain("sub_skipped");
    expect(r.flags).not.toContain("sub_paused");
  });

  it("no phrasing routes cancel through the skip auto-execution path (the cancel firewall holds)", async () => {
    const c = new MockCommerceAdapter();
    const r = await handleSupport(c, shopper, "cancel my subscription, skip billing me", undefined, { enabled: true, shopperVerified: true });
    expect(r.flags).toContain("cancel_sub_routed");
    expect(r.flags).not.toContain("sub_skipped");
  });

  // steward finding 1 (HIGH): a MIXED message classified as skip must not auto-skip and drop the cancel
  // from human view (pre-branch such a message escalated).
  for (const msg of [
    "cancel but skip next month",
    "I want to cancel, or at least skip next month",
    "can you cancel my plan? otherwise skip next delivery",
    "please cancel — but for now just skip next delivery",
  ]) {
    it(`mixed intent "${msg}" ⇒ routes to a human, never auto-skips`, async () => {
      const c = new MockCommerceAdapter();
      const r = await handleSupport(c, shopper, msg, undefined, { enabled: true, shopperVerified: true });
      expect(r.escalate).toBe(true);
      expect(r.flags).not.toContain("sub_skipped");
      expect(r.flags).not.toContain("autonomous_action");
    });
  }
});

describe("ADR-0016 review nits — retrospective intent + flag-gated reversal classification", () => {
  it('security-review L1: "you skipped my delivery, why?" never auto-executes a NEW skip', async () => {
    const c = new MockCommerceAdapter();
    const r = await handleSupport(c, shopper, "you skipped my delivery, why?", undefined, { enabled: true, shopperVerified: true });
    expect(r.flags).not.toContain("sub_skipped");
    expect(r.flags).not.toContain("autonomous_action");
  });
  it("steward finding 2: reversal-only phrasing is flag-gated (flag-off is byte-identical to main)", () => {
    // "resume my subscription" / "put my delivery back" contain NO skip/pause substring, so flag-off they
    // fall through to the generic path exactly like main; flag-on they become a reachable reversal intent.
    // (NB "unpause" DOES contain "pause" → the base regex classifies it as skip_subscription either way,
    // which is byte-identical to main — the flag-gate is only load-bearing for the no-skip/pause phrasings.)
    expect(classifySupportIntent("resume my subscription", false)).not.toBe("skip_subscription");
    expect(classifySupportIntent("put my delivery back", false)).not.toBe("skip_subscription");
    expect(classifySupportIntent("resume my subscription", true)).toBe("skip_subscription");
    expect(classifySupportIntent("put my delivery back", true)).toBe("skip_subscription");
  });
});

describe("kill switch precedence is unchanged — a killed session never reaches an autonomous action", () => {
  it("signals.kill blocks the skip even with the flag on and a verified shopper", async () => {
    const commerce = new MockCommerceAdapter();
    const brain = createBrain(new MockModelAdapter(), new StaticGroundingAdapter(), DEFAULT_POLICY, commerce, "shopper-demo", undefined, true);
    const decision = await brain.decide({ tenantId: "demo", shopperId: "shopper-demo", kill: true }, "skip my next delivery");
    expect(decision.flags).toContain("kill_switch");
    expect(decision.flags).not.toContain("sub_skipped");
    expect(decision.escalateToHuman).toBe(true);
    const sub = await commerce.getSubscription("shopper-demo");
    expect(sub?.nextDeliverySkipped).toBe(false); // nothing executed
  });
});
