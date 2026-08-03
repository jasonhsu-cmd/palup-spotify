import { describe, it, expect } from "vitest";
import { createBrain, MockModelAdapter, StaticGroundingAdapter, MockCommerceAdapter, DEFAULT_POLICY, type Policy } from "@palup/widget-brain";
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
});
