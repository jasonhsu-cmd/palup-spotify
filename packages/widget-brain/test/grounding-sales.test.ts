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
    expect(s).toMatch(/ask a brief clarifying question/);
    expect(s).toMatch(/never claim something is low-stock/);
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
