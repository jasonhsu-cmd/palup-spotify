import { describe, it, expect } from "vitest";
import {
  createBrain,
  MockModelAdapter,
  StaticGroundingAdapter,
  MockCommerceAdapter,
  DEFAULT_POLICY,
} from "../src/index.js";
import type { ModelPort } from "@palup/platform-ports";

// WS6 — the first-touch proactive greeting (acquire). AGENT-INITIATED (empty shopper turn +
// proactiveTrigger:"greeting"), on the CLEAN path only, behind GREETING_PROACTIVE. NON-COMMERCIAL by
// construction: pitch:"none", never selectPitch, no INV-E budget spend, no offer.

// greetingProactiveEnabled is createBrain's LAST positional param — pass `undefined` for the 18 middle
// params (JS default params apply) and the flag last.
function greetingBrain(enabled: boolean, model: ModelPort = new MockModelAdapter()) {
  return createBrain(
    model, new StaticGroundingAdapter(), DEFAULT_POLICY, new MockCommerceAdapter(), "shopper-demo",
    undefined, undefined, undefined, undefined, undefined, // memory, subscription, disposition×3
    undefined, undefined, undefined, undefined, undefined, undefined, // catalogRetriever, retrievalEnabled, K, citations, cards, cartLineItems
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, // serverGuard, factsPort, hydration, offerModel, offerCheck, maxAge, turnEmbedder
    enabled, // greetingProactiveEnabled
  );
}
const GREET = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  tenantId: "demo",
  proactiveTrigger: "greeting",
  mood: "neutral",
  ...extra,
});

describe("WS6 — greeting rung, flag ON", () => {
  it("empty greeting turn → a warm smalltalk welcome, pitch:none, no offer, labeled proactive", async () => {
    const brain = greetingBrain(true);
    const d = await brain.decide(GREET({ relationship: "anonymous" }) as never, "");
    expect(d.mode).toBe("smalltalk");
    expect(d.pitch).toBe("none");
    expect(d.outbound).toBe(false);
    expect(d.escalateToHuman).toBe(false);
    expect(d.reply.length).toBeGreaterThan(0);
    expect(d.flags).toContain("proactive:greeting");
    expect(d).not.toHaveProperty("recommendedProducts");
  });

  it("at cap (§8a inv-14) → QUIET: empty reply, pitch none, no model spend", async () => {
    const spy = { complete: (async () => ({ text: "should not be called", model: "spy" })) as ModelPort["complete"] };
    let calls = 0;
    const counting: ModelPort = { complete: async (...a) => (calls++, spy.complete(...a)) };
    const brain = greetingBrain(true, counting);
    const d = await brain.decide(GREET({ atCap: true }) as never, "");
    expect(d.reply).toBe("");
    expect(d.pitch).toBe("none");
    expect(d.flags).toContain("at_cap");
    expect(calls).toBe(0); // no proactive model spend at cap
  });

  it("a greeting never invents a discount — the reply-integrity backstop catches it", async () => {
    const brain = greetingBrain(true, { complete: async () => ({ text: "Welcome! Here's 20% off today only!", model: "spy" }) });
    const d = await brain.decide(GREET() as never, "");
    expect(d.flags).toContain("reply_integrity:ungrounded_discount");
    expect(d.pitch).toBe("none");
    expect(d.reply).not.toContain("20%");
  });
});

describe("WS6 — greeting rung, flag OFF (inert)", () => {
  it("empty greeting turn → QUIET (never falls through to the sales model), flagged greeting_disabled", async () => {
    let calls = 0;
    const counting: ModelPort = { complete: async () => (calls++, { text: "SALES REPLY", model: "spy" }) };
    const brain = greetingBrain(false, counting);
    const d = await brain.decide(GREET() as never, "");
    expect(d.reply).toBe("");
    expect(d.pitch).toBe("none");
    expect(d.flags).toContain("greeting_disabled");
    expect(calls).toBe(0); // an empty greeting turn must NOT reach the reactive sales model when off
  });
});

describe("WS6 — greeting NEVER overrides a brake (precedence)", () => {
  it("safety latched + greeting → mode safety, pitch none (INV-A latch wins)", async () => {
    const brain = greetingBrain(true);
    const d = await brain.decide(GREET({ safetyLatched: true }) as never, "");
    expect(d.mode).toBe("safety");
    expect(d.pitch).toBe("none");
    expect(d.flags).not.toContain("proactive:greeting");
  });

  it("kill switch + greeting → escalate, no greeting (operator halt outranks everything)", async () => {
    const brain = greetingBrain(true);
    const d = await brain.decide(GREET({ kill: true }) as never, "");
    expect(d.pitch).toBe("none");
    expect(d.flags).toContain("kill_switch");
    expect(d.flags).not.toContain("proactive:greeting");
  });
});
