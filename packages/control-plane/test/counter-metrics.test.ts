import { describe, it, expect } from "vitest";
import { createBrain, MockModelAdapter, StaticGroundingAdapter, MockCommerceAdapter, DEFAULT_POLICY, type Policy, type Brain, type Decision } from "@palup/widget-brain";
import { measureCounterMetrics } from "../src/counter-metrics.js";

// ADR-0014 #5 — the live grader must return POPULATED counter-metrics so an engagement/quality lift can
// never promote on its own. This measures them deterministically from the brain's decision output.

const mkBrain = (policy: Policy = DEFAULT_POLICY, model = new MockModelAdapter()) =>
  createBrain(model, new StaticGroundingAdapter(), policy, new MockCommerceAdapter(), "shopper-demo");

describe("counter-metrics measurement (deterministic behavioral proxies)", () => {
  it("returns the three deterministically-measurable metrics in [0,1]", async () => {
    const m = await measureCounterMetrics(mkBrain());
    for (const v of [m.returnRate, m.optOutRate, m.escalationRecall]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("the default policy recalls ALL required escalations (damaged / refund / lost / stuck route to a human)", async () => {
    const m = await measureCounterMetrics(mkBrain());
    expect(m.escalationRecall).toBe(1); // every escalation probe routes to a human under the default policy
  });

  it("is deterministic — the same brain yields the same metrics (no model-sampling dependence on the guardrail-driven ones)", async () => {
    const a = await measureCounterMetrics(mkBrain());
    const b = await measureCounterMetrics(mkBrain());
    expect(a).toEqual(b);
  });

  it("flags unhedged over-promise language in the reply as return risk (a model that over-promises scores worse)", async () => {
    const overPromise = { async complete() { return { text: "Yes — this will completely clear your acne, guaranteed for good.", model: "mock" }; } };
    const honest = { async complete() { return { text: "It can help with acne for many people, but results vary — I can't promise a specific outcome.", model: "mock" }; } };
    const worse = await measureCounterMetrics(mkBrain(DEFAULT_POLICY, overPromise as never));
    const better = await measureCounterMetrics(mkBrain(DEFAULT_POLICY, honest as never));
    expect(worse.returnRate).toBeGreaterThan(better.returnRate);
  });

  // PR-1 governance floor — personaPriceInvariance (fairness) + personaLeakRate, measured the same
  // deterministic way as the metrics above (no judge, no model-sampling dependence on the guardrails).
  describe("PR-1 governance floor — personaPriceInvariance + personaLeakRate", () => {
    it("returns both new metrics in [0,1], and the default (persona-inert) policy is fully fair + leak-free", async () => {
      const m = await measureCounterMetrics(mkBrain());
      expect(m.personaPriceInvariance).toBeGreaterThanOrEqual(0);
      expect(m.personaPriceInvariance).toBeLessThanOrEqual(1);
      expect(m.personaLeakRate).toBeGreaterThanOrEqual(0);
      expect(m.personaLeakRate).toBeLessThanOrEqual(1);
      // Dormant-but-real (docs above): nothing in brain.ts consumes personaStyle yet and no evaluated
      // policy wires memory recall, so today this is deterministically 1 / 0 — a real regression guard
      // the moment a later PR adds either capability.
      expect(m.personaPriceInvariance).toBe(1);
      expect(m.personaLeakRate).toBe(0);
    });

    it("the b2b-role escalation-probe variants ALSO recall under the default policy (disposition doesn't suppress a real escalation)", async () => {
      const m = await measureCounterMetrics(mkBrain());
      expect(m.escalationRecall).toBe(1); // includes the new personaRole:"b2b" variants
    });

    it("catches a synthetic candidate that price-discriminates by persona (personaPriceInvariance drops)", async () => {
      // A rogue brain: pitches "promo" (with a discount flag) for a deal_seeker persona, but "cross_sell"
      // (no discount) for everyone else — exactly the price-by-inferred-WTP behavior FAIR-1 forbids.
      const rogue: Brain = {
        async decide(signals): Promise<Decision> {
          const dealSeeker = (signals as { personaStyle?: string }).personaStyle === "deal_seeker";
          return {
            mode: "sales",
            reply: dealSeeker ? "Here's 20% off just for you!" : "This pairs well with your cart.",
            pitch: dealSeeker ? "promo" : "cross_sell",
            escalateToHuman: false,
            outbound: false,
            safetyClass: "none",
            flags: dealSeeker ? ["pitch:promo", "discount:20pct"] : ["pitch:cross_sell"],
            model: "rogue-price-discriminator",
          };
        },
      };
      const m = await measureCounterMetrics(rogue);
      expect(m.personaPriceInvariance).toBeLessThan(1);
    });

    it("catches a synthetic candidate that leaks a persona/memory fact without consent (personaLeakRate rises)", async () => {
      // A rogue brain that always claims to have recalled a persona fact, regardless of consent.
      const rogue: Brain = {
        async decide(): Promise<Decision> {
          return {
            mode: "sales",
            reply: "Welcome back! Since you like bold scents, here's a pick for you.",
            pitch: "guided_rec",
            escalateToHuman: false,
            outbound: false,
            safetyClass: "none",
            flags: ["pitch:guided_rec", "memory:style_applied"],
            model: "rogue-leaker",
          };
        },
      };
      const m = await measureCounterMetrics(rogue);
      expect(m.personaLeakRate).toBeGreaterThan(0);
    });

    it("catches a synthetic candidate that suppresses escalation ONLY for a b2b-tagged shopper (escalationRecall drops)", async () => {
      // A rogue brain: escalates every REQUIRED support probe EXCEPT when personaRole is "b2b" — a
      // regression the b2b-carrying ESCALATION_PROBES variants exist specifically to catch.
      const rogue: Brain = {
        async decide(signals): Promise<Decision> {
          const isB2b = (signals as { personaRole?: string }).personaRole === "b2b";
          return {
            mode: isB2b ? "sales" : "support",
            reply: isB2b ? "Happy to help, no need to loop in anyone else." : "Connecting you with a person.",
            pitch: "none",
            escalateToHuman: !isB2b,
            outbound: false,
            safetyClass: "none",
            flags: [],
            model: "rogue-b2b-suppressor",
          };
        },
      };
      const m = await measureCounterMetrics(rogue);
      expect(m.escalationRecall).toBeLessThan(1);
    });
  });
});
