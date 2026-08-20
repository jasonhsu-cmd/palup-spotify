import { describe, it, expect, vi } from "vitest";
import type { ModelPort, ModelRequest } from "@palup/platform-ports";
import { createBrain, DEFAULT_POLICY, StaticGroundingAdapter, MockCommerceAdapter } from "../src/index.js";

// Shopper-disposition program PR-4 — behavioral one-strike + cross-turn counters (flag
// DISPOSITION_BEHAVIORAL). The brain only CONSUMES signals.behavioral (BehavioralEvent[], PR-0) for
// THIS turn; cross-turn bookkeeping (arming the one-strike, running counters) is session.ts's job
// (session-behavioral.test.ts). This suite locks the brain-level contract in isolation:
//   - pitch_declined suppresses the very next PROACTIVE pitch (forces pitch:none, quiet reply)
//   - rage NEVER yields pitch != none, on the reactive sales path AND the proactive path, and escalates
//   - repeat_question adds a benign "recall, don't re-ask" directive to systemExtra only
//   - flag OFF (default) => byte-identical to a decision with no behavioral signals at all
//   - none of this ever reaches selectPitch's price/offer surface (FAIR-1, Inv 10): no offer is ADDED,
//     only ever suppressed; outbound/price untouched.
function spyBrain(dispositionBehavioralEnabled = false) {
  const spy = vi.fn<ModelPort["complete"]>(async () => ({ text: "ok", model: "spy" }));
  const brain = createBrain(
    { complete: spy },
    new StaticGroundingAdapter(),
    DEFAULT_POLICY,
    new MockCommerceAdapter(),
    "shopper-demo",
    undefined, // memory
    false, // subscriptionSelfServeEnabled
    false, // dispositionStyleEnabled
    dispositionBehavioralEnabled,
  );
  return { brain, spy };
}
const sys = (spy: ReturnType<typeof vi.fn>) =>
  ((spy.mock.calls[0]?.[0] as ModelRequest | undefined)?.messages.find((m) => m.role === "system")?.content ?? "");

const PRICE_LANGUAGE = /%|\$\d|\btier\b|discount|coupon|promo/i;

describe("PR-4 — behavioral one-strike + cross-turn counters (flag DISPOSITION_BEHAVIORAL)", () => {
  describe("pitch_declined -> suppress the NEXT proactive pitch", () => {
    it("flag ON: a proactive exit-intent turn carrying pitch_declined is suppressed to pitch:none, quiet reply", async () => {
      const { brain, spy } = spyBrain(true);
      const d = await brain.decide(
        { cart: "has_items", proactiveTrigger: "exit_intent", behavioral: ["pitch_declined"] },
        "",
      );
      expect(d.pitch).toBe("none");
      expect(d.reply).toBe(""); // quiet - never nags
      expect(d.flags).toContain("behavioral:declined");
      expect(d.flags).toContain("disposition:one_strike");
      expect(d.flags).not.toContain("pitch:cart_recovery");
      expect(spy).not.toHaveBeenCalled(); // suppressed before generation, like every other quiet proactive path
    });

    it("flag ON: WITHOUT pitch_declined, the same proactive turn still fires the normal cart-recovery pitch (no false suppression)", async () => {
      const { brain, spy } = spyBrain(true);
      const d = await brain.decide({ cart: "has_items", proactiveTrigger: "exit_intent" }, "");
      expect(d.pitch).toBe("cart_recovery");
      void spy;
    });

    it("flag ON: pitch_declined does NOT suppress a REACTIVE sales turn (only the proactive rung is targeted)", async () => {
      const { brain } = spyBrain(true);
      const d = await brain.decide(
        { cart: "has_items", proactivityLevel: "balanced", behavioral: ["pitch_declined"] },
        "tell me about the serum",
      );
      expect(d.pitch).not.toBe("none"); // reactive pitch selection is unaffected
    });
  });

  describe("rage -> never a buy; help/escalate", () => {
    it("flag ON: rage on the reactive sales path forces pitch:none and escalates, never adds an offer", async () => {
      const { brain, spy } = spyBrain(true);
      const d = await brain.decide(
        { cart: "has_items", proactivityLevel: "confident", behavioral: ["rage"] },
        "tell me about the serum",
      );
      expect(d.pitch).toBe("none");
      expect(d.escalateToHuman).toBe(true);
      expect(d.flags).toContain("behavioral:rage");
      expect(d.flags).toContain("no_pitch");
      expect(d.outbound).toBe(false);
      expect(sys(spy)).not.toMatch(/PITCH - /); // no pitch playbook text reaches the model
    });

    // F5/F6 — rage on the reactive path must relabel `mode` as "support" (the harness's own aggregate
    // cases, t8-sit-rage-multiturn / t10-multiturn-rage-escalation, pin "support" — not "sales" and not
    // "safety", which stays reserved for the safety classifier / self-harm latch). escalate/pitch/flags
    // are unchanged by this fix — only the mode label moves.
    it("F5: rage on the reactive sales path relabels mode to support", async () => {
      const { brain } = spyBrain(true);
      const d = await brain.decide(
        { cart: "has_items", proactivityLevel: "confident", behavioral: ["rage"] },
        "tell me about the serum",
      );
      expect(d.mode).toBe("support");
    });

    it("flag ON: rage overrides an explicit buy signal too - never a buy", async () => {
      const { brain } = spyBrain(true);
      const d = await brain.decide(
        { cart: "has_items", behavioral: ["rage"] },
        "I'll take it, checkout now",
      );
      expect(d.pitch).toBe("none");
      expect(d.escalateToHuman).toBe(true);
    });

    it("flag ON: rage on the PROACTIVE exit-intent path also never yields a pitch, and escalates", async () => {
      const { brain, spy } = spyBrain(true);
      const d = await brain.decide(
        { cart: "has_items", proactiveTrigger: "exit_intent", behavioral: ["rage"] },
        "",
      );
      expect(d.pitch).toBe("none");
      expect(d.escalateToHuman).toBe(true);
      expect(d.flags).toContain("behavioral:rage");
      expect(spy).not.toHaveBeenCalled();
    });

    // F11 — before this fix, rage handling existed ONLY on the reactive sales path (above) and the
    // proactive exit-intent path, never in the support branch. A raging shopper whose message ALSO
    // names a concrete support issue (correctly routed to mode:support, via handleSupport when a
    // CommercePort is wired) got ZERO rage-specific escalation: "damaged" with no stated order id/amount
    // resolves an order under the refund ceiling, so handleSupport's own escalate stays false — a raging
    // shopper ended up LESS escalated than the reactive-sales-path rage case above. Mirrors the eval
    // harness's t10-multiturn-rage-escalation case (packages/eval/cases/widget-behavioral.json), whose
    // final turn has no CommercePort wired and hits brain.ts's own no-commerce support fallback instead —
    // covered by the case's own "no_pitch"/"escalate" pairing; this test pins the commerce-backed
    // handleSupport call site named directly in finding F11.
    describe("rage also escalates the SUPPORT path (handleSupport call site)", () => {
      const SUPPORT_MESSAGE = "My order arrived broken and nobody has fixed it.";

      it("flag ON + rage: a support-routed message (damaged, under the refund ceiling) still escalates and carries behavioral:rage", async () => {
        const { brain } = spyBrain(true);
        const d = await brain.decide({ behavioral: ["rage"] }, SUPPORT_MESSAGE);
        expect(d.mode).toBe("support");
        expect(d.pitch).toBe("none");
        expect(d.escalateToHuman).toBe(true);
        expect(d.flags).toContain("behavioral:rage");
        expect(d.flags).toContain("no_pitch");
      });

      it("flag ON, no rage: the SAME support message keeps handleSupport's own (non-escalating) decision — normal support behavior unchanged", async () => {
        const { brain } = spyBrain(true);
        const d = await brain.decide({}, SUPPORT_MESSAGE);
        expect(d.mode).toBe("support");
        expect(d.escalateToHuman).toBe(false); // damaged, order under the refund ceiling -> handleSupport itself does not escalate
        expect(d.flags).not.toContain("behavioral:rage");
      });

      it("flag OFF, rage present: ignored, exactly like the reactive/proactive rage cases above", async () => {
        const { brain } = spyBrain(false);
        const d = await brain.decide({ behavioral: ["rage"] }, SUPPORT_MESSAGE);
        expect(d.mode).toBe("support");
        expect(d.escalateToHuman).toBe(false);
        expect(d.flags).not.toContain("behavioral:rage");
      });
    });
  });

  describe("repeat_question -> recall, don't re-ask directive (systemExtra only)", () => {
    it("flag ON: adds the recall directive to systemExtra and the behavioral:repeat_question flag; pitch selection unaffected", async () => {
      const { brain, spy } = spyBrain(true);
      const d = await brain.decide(
        { cart: "has_items", proactivityLevel: "balanced", behavioral: ["repeat_question"] },
        "tell me about the serum",
      );
      expect(sys(spy)).toMatch(/recall|already told them/i);
      expect(d.flags).toContain("behavioral:repeat_question");
      expect(d.pitch).not.toBe("none"); // only a voice nudge - never suppresses a pitch on its own
    });

    it("the directive itself never contains price/offer/tier language", async () => {
      const { brain, spy } = spyBrain(true);
      await brain.decide({ cart: "has_items", behavioral: ["repeat_question"] }, "tell me about the serum");
      const line = sys(spy)
        .split("\n")
        .find((l) => l.startsWith("BEHAVIORAL - repeat question")) ?? "";
      expect(line.length).toBeGreaterThan(0);
      expect(PRICE_LANGUAGE.test(line)).toBe(false);
    });
  });

  describe("ships inert: flag OFF (default)", () => {
    it("pitch_declined on a proactive turn is ignored - normal cart-recovery pitch still fires", async () => {
      const { brain } = spyBrain(false);
      const d = await brain.decide(
        { cart: "has_items", proactiveTrigger: "exit_intent", behavioral: ["pitch_declined"] },
        "",
      );
      expect(d.pitch).toBe("cart_recovery");
      expect(d.flags).not.toContain("disposition:one_strike");
    });

    it("rage is ignored - normal pitch selection proceeds, no forced escalation", async () => {
      const { brain } = spyBrain(false);
      const d = await brain.decide(
        { cart: "has_items", proactivityLevel: "confident", behavioral: ["rage"] },
        "tell me about the serum",
      );
      expect(d.pitch).not.toBe("none");
      expect(d.escalateToHuman).toBe(false);
      expect(d.flags).not.toContain("behavioral:rage");
    });

    it("repeat_question is ignored - no directive text, no flag", async () => {
      const { brain, spy } = spyBrain(false);
      const d = await brain.decide({ cart: "has_items", behavioral: ["repeat_question"] }, "tell me about the serum");
      expect(sys(spy)).not.toMatch(/BEHAVIORAL - repeat question/);
      expect(d.flags).not.toContain("behavioral:repeat_question");
    });

    it("byte-identical to a decision with no behavioral signals at all, flag OFF", async () => {
      const off1 = spyBrain(false);
      const off2 = spyBrain(false);
      const withBehavioral = await off1.brain.decide(
        { cart: "has_items", behavioral: ["rage", "repeat_question", "pitch_declined"] },
        "tell me about the serum",
      );
      const withoutBehavioral = await off2.brain.decide({ cart: "has_items" }, "tell me about the serum");
      expect(sys(off1.spy)).toBe(sys(off2.spy));
      expect(withBehavioral.flags).toEqual(withoutBehavioral.flags);
      expect(withBehavioral.pitch).toBe(withoutBehavioral.pitch);
      expect(withBehavioral.escalateToHuman).toBe(withoutBehavioral.escalateToHuman);
    });
  });

  describe("never reaches selectPitch's price/offer surface", () => {
    it("repeat_question directive never appends a PITCH playbook or discount language", async () => {
      const { brain, spy } = spyBrain(true);
      await brain.decide({ cart: "has_items", proactivityLevel: "balanced", behavioral: ["repeat_question"] }, "tell me about the serum");
      expect(sys(spy)).not.toMatch(/%\s*(off|discount)|\$\d+\s*off|promo code|coupon code/i);
    });

    it("rage/decline suppression only ever DROPS a pitch, never selects one that wasn't otherwise eligible", async () => {
      const { brain } = spyBrain(true);
      // cart empty + no buy signal + rage: selectPitch would already be capped by other rules; rage must
      // never turn a "none" into an offer - it stays none, same as flag-off with an empty cart.
      const d = await brain.decide({ cart: "empty", behavioral: ["rage"] }, "hi there");
      expect(d.pitch).toBe("none");
    });
  });
});
