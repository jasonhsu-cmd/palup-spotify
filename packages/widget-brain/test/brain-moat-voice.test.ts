import { describe, it, expect, vi } from "vitest";
import type { ModelPort, ModelRequest } from "@palup/platform-ports";
import { createBrain, DEFAULT_POLICY, StaticGroundingAdapter, MockCommerceAdapter } from "../src/index.js";

// Moat quality levers (2026-08-07): (1) positive-mood restraint and (2) relationship-stage VOICE. Both are
// VOICE-ONLY — they append ONE code-owned directive to the system prompt + push one flag, and NEVER change
// pitch / outbound / price (FAIR-1, Inv 10), mirroring the existing skeptic/EU/persona voice directives.
// The quality LIFT is validated separately by live eval:full; these tests pin the DETERMINISTIC contract:
// the directive is injected, the flag is set, and the commercial surface is unchanged — including the
// FAIR-3 VIP invariant (VIP → normal guided_rec, never upsell/promo/subscription).
function spyBrain() {
  const spy = vi.fn<ModelPort["complete"]>(async () => ({ text: "ok", model: "spy" }));
  const brain = createBrain({ complete: spy }, new StaticGroundingAdapter(), DEFAULT_POLICY, new MockCommerceAdapter(), "shopper-demo");
  return { brain, spy };
}
// The clean-sales REPLY (brain.ts, the `systemExtra + PITCH_PLAYBOOK[pitch]` call) may not be the FIRST
// model.complete on a discovery turn (an earlier grounding pass can precede it), so search EVERY call's
// system message — the directive lands in whichever call is the shopper-facing reply.
const sysPrompt = (spy: ReturnType<typeof vi.fn>) =>
  spy.mock.calls
    .map((c) => ((c[0] as ModelRequest | undefined)?.messages.find((m) => m.role === "system")?.content ?? ""))
    .join("\n---\n");

describe("moat lever — positive-mood restraint (satisfied)", () => {
  it("injects a service-first restraint directive + flag, WITHOUT changing the pitch (voice only)", async () => {
    const { brain, spy } = spyBrain();
    const d = await brain.decide({ mood: "satisfied", cart: "has_items", proactivityLevel: "balanced" }, "these look great, anything else i should grab?");
    expect(d.flags).toContain("mood_positive");
    expect(sysPrompt(spy).toLowerCase()).toContain("positive-mood restraint");
    // FAIR-1 / voice-only: a satisfied has-items shopper still gets the SAME pitch the selector chooses
    // (cross_sell). Restraint tempers the VOICE, it does not suppress or change the pitch surface.
    expect(d.pitch).toBe("cross_sell");
    expect(d.outbound).toBe(false);
  });
  it("is inert for a non-satisfied mood", async () => {
    const { brain, spy } = spyBrain();
    const d = await brain.decide({ mood: "neutral", cart: "has_items", proactivityLevel: "balanced" }, "anything else?");
    expect(d.flags).not.toContain("mood_positive");
    expect(sysPrompt(spy).toLowerCase()).not.toContain("positive-mood restraint");
  });
});

describe("moat lever — relationship-stage voice", () => {
  for (const rel of ["new", "repeat", "vip", "subscriber", "replenishment_due", "lapsed", "one_and_done"]) {
    it(`relationship=${rel}: injects a stage voice directive + rel_voice flag`, async () => {
      const { brain, spy } = spyBrain();
      const d = await brain.decide({ relationship: rel as never, cart: "empty", proactivityLevel: "balanced" }, "what should I get for dull skin?");
      expect(d.flags).toContain(`rel_voice:${rel}`);
      expect(sysPrompt(spy).toLowerCase()).toContain("relationship -");
    });
  }

  it("VIP → normal guided_rec, NEVER upsell/promo/subscription, no outbound (FAIR-3 invariant preserved)", async () => {
    const { brain } = spyBrain();
    const d = await brain.decide({ relationship: "vip", cart: "empty", proactivityLevel: "balanced", mood: "neutral" }, "money is no object, what should I get for dull skin?");
    expect(d.pitch).toBe("guided_rec");
    expect(["upsell", "promo", "subscription"]).not.toContain(d.pitch);
    expect(d.outbound).toBe(false);
  });

  it("does not change the pitch surface — lapsed still routes to the EXISTING replenishment pitch", async () => {
    const { brain } = spyBrain();
    const d = await brain.decide({ relationship: "lapsed", proactivityLevel: "balanced" }, "hi");
    expect(d.pitch).toBe("replenishment"); // pre-existing selectPitch behavior, unchanged by the voice directive
  });

  it("anonymous gets NO relationship voice directive", async () => {
    const { brain } = spyBrain();
    const d = await brain.decide({ relationship: "anonymous", cart: "empty", proactivityLevel: "balanced" }, "hi");
    expect(d.flags.find((f) => f.startsWith("rel_voice:"))).toBeUndefined();
  });
});
