import { describe, it, expect, vi } from "vitest";
import type { ModelPort, ModelRequest } from "@palup/platform-ports";
import { createBrain, StaticGroundingAdapter } from "../src/index.js";

// The reply CONTENT is the live model's job (judged by eval:full). What we can lock deterministically:
// the competitor-mode routing + the honesty rules present in the system prompt.
function spyBrain() {
  const spy = vi.fn<ModelPort["complete"]>(async () => ({ text: "ok", model: "spy" }));
  return { brain: createBrain({ complete: spy }, new StaticGroundingAdapter()), spy };
}
const sys = (spy: ReturnType<typeof vi.fn>) =>
  ((spy.mock.calls[0]![0] as ModelRequest).messages.find((m) => m.role === "system")?.content ?? "");

describe("grounding / honesty system prompt", () => {
  it("injects the anti-fabrication + honest-advisor + clarify rules", async () => {
    const { brain, spy } = spyBrain();
    await brain.decide({ cart: "has_items" }, "which serum is best?");
    const s = sys(spy);
    expect(s).toMatch(/never invent a spec, price, ETA/);
    expect(s).toMatch(/correct them honestly/);
    expect(s).toMatch(/ask one short clarifying question in the SAME reply/);
    expect(s).toMatch(/never claim something is low-stock/);
  });

  it("injects the chosen pitch directive into the model prompt (RC1: pitch now reaches the model)", async () => {
    const { brain, spy } = spyBrain();
    await brain.decide({ cart: "has_items" }, "which serum is best?"); // cart → cross_sell pitch
    expect(sys(spy)).toMatch(/PITCH - cross-sell/);
  });

  it("an explicit buy/checkout signal forces pitch=none — no upsell directive reaches the model (restraint-after-close)", async () => {
    const { brain, spy } = spyBrain();
    const d = await brain.decide({ cart: "has_items" }, "I'll take the niacinamide serum, checkout?");
    expect(d.pitch).toBe("none");
    expect(d.flags).toContain("buy_signal");
    expect(sys(spy)).not.toMatch(/PITCH - cross-sell/); // the contradictory cross-sell nudge is gone
  });

  it("word-boundary support gate: 'returning' (browsing) routes to sales, not support", async () => {
    const { brain } = spyBrain();
    const d = await brain.decide({}, "I'm returning to skincare after a long break — what's good for me?");
    expect(d.mode).toBe("sales"); // substring 'return' inside 'returning' no longer mis-routes to support
  });

  it("EU jurisdiction: region=eu injects the data-residency directive", async () => {
    const { brain, spy } = spyBrain();
    const d = await brain.decide({ region: "eu" }, "which moisturizer do you recommend?");
    expect(d.flags).toContain("jurisdiction:eu");
    expect(sys(spy)).toMatch(/DATA-RESIDENCY POLICY/);
  });
});

describe("competitor-mode handling", () => {
  const cases = [
    { mode: "off" as const, expect: /Do NOT discuss competitor specifics/ },
    { mode: "general" as const, expect: /GENERAL comparison/ },
    { mode: "full" as const, expect: /cite a source/ },
  ];
  for (const c of cases) {
    it(`mode ${c.mode}: sets flag + injects the right policy`, async () => {
      const { brain, spy } = spyBrain();
      const d = await brain.decide({ groundingMode: c.mode }, "how do you compare to Brand Y?");
      expect(d.flags).toContain(`competitor:${c.mode}`);
      expect(sys(spy)).toMatch(c.expect);
      expect(sys(spy)).toMatch(/[Nn]ever disparage/);
    });
  }
});
