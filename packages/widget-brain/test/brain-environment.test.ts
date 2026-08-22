import { describe, it, expect, vi } from "vitest";
import type { ModelPort, ModelRequest } from "@palup/platform-ports";
import { createBrain, DEFAULT_POLICY, StaticGroundingAdapter, MockCommerceAdapter } from "../src/index.js";

// WS-B4' — environment signals (device + entry), SAME flag DISPOSITION_STYLE as the persona-style/-role/
// relationship directives this mirrors (brain-persona-style.test.ts / brain-persona-role.test.ts). `device`
// is SERVER-derived (widget-backend/src/signals.ts's classifyDevice, from the request's own user-agent);
// `entry` is accepted from the client, non-trust-bearing like mood (a spoofed entry can only change tone).
// What's locked here deterministically is (a) the matching directive reaches the system prompt when the
// flag is ON, (b) the matching device:*/entry:* flag is emitted, (c) the flag OFF (default) leaves the
// prompt/flags byte-identical to before this PR, and (d) NONE of this ever touches pitch/selectPitch/
// outbound/price (FAIR-1, Inv 10) — a mobile shopper who arrived from an ad gets the EXACT same pitch
// surface as a desktop shopper who arrived directly.
function spyBrain(dispositionStyleEnabled = false) {
  const spy = vi.fn<ModelPort["complete"]>(async () => ({ text: "ok", model: "spy" }));
  const brain = createBrain(
    { complete: spy },
    new StaticGroundingAdapter(),
    DEFAULT_POLICY,
    new MockCommerceAdapter(),
    "shopper-demo",
    undefined, // memory
    false, // subscriptionSelfServeEnabled
    dispositionStyleEnabled,
  );
  return { brain, spy };
}
const sys = (spy: ReturnType<typeof vi.fn>) =>
  ((spy.mock.calls[0]![0] as ModelRequest).messages.find((m) => m.role === "system")?.content ?? "");

// Isolate JUST the injected device/entry lines (same reasoning as brain-persona-style.test.ts's
// personaLine: the GROUNDED catalog itself legitimately contains a "%").
const deviceLine = (spy: ReturnType<typeof vi.fn>) =>
  sys(spy)
    .split("\n")
    .find((l) => l.startsWith("DEVICE")) ?? "";
const entryLine = (spy: ReturnType<typeof vi.fn>) =>
  sys(spy)
    .split("\n")
    .find((l) => l.startsWith("ENTRY")) ?? "";

// No price/offer/tier language may appear in either directive, ever (same widened list brain-persona-
// role.test.ts uses — governance BLOCK closure, Finding 7).
const PRICE_LANGUAGE =
  /%|\$\d|\btier\b|\bprice\b|\bpricing\b|\bdiscount\b|\bpromo(?:tion|s)?\b|\bcoupon\b|\bdeal\b|\boffer(?:s|ing)?\b|free shipping/i;

describe("WS-B4' — environment directives (device + entry, flag DISPOSITION_STYLE)", () => {
  it("flag ON + device=mobile → the mobile directive reaches the prompt, device:mobile flag set", async () => {
    const { brain, spy } = spyBrain(true);
    const d = await brain.decide({ cart: "has_items", device: "mobile" }, "tell me about the serum");
    expect(sys(spy)).toMatch(/DEVICE - mobile/);
    expect(d.flags).toContain("device:mobile");
    expect(PRICE_LANGUAGE.test(deviceLine(spy))).toBe(false);
  });

  it("flag ON + entry=ad → the ad directive reaches the prompt, entry:ad flag set", async () => {
    const { brain, spy } = spyBrain(true);
    const d = await brain.decide({ cart: "has_items", entry: "ad" }, "tell me about the serum");
    expect(sys(spy)).toMatch(/ENTRY - ad/);
    expect(d.flags).toContain("entry:ad");
    expect(PRICE_LANGUAGE.test(entryLine(spy))).toBe(false);
  });

  it("flag OFF (default) — supplied device/entry are NEVER consumed: no DEVICE/ENTRY text, no device:*/entry:* flag (ships inert)", async () => {
    const { brain, spy } = spyBrain(false);
    const d = await brain.decide({ cart: "has_items", device: "mobile", entry: "ad" }, "tell me about the serum");
    expect(sys(spy)).not.toMatch(/DEVICE - mobile/);
    expect(sys(spy)).not.toMatch(/ENTRY - ad/);
    expect(d.flags.some((f) => f.startsWith("device:") || f.startsWith("entry:"))).toBe(false);
  });

  it("flag OFF is byte-identical to a decision with no device/entry at all", async () => {
    const off1 = spyBrain(false);
    const off2 = spyBrain(false);
    const withEnv = await off1.brain.decide({ cart: "has_items", device: "mobile", entry: "ad" }, "tell me about the serum");
    const withoutEnv = await off2.brain.decide({ cart: "has_items" }, "tell me about the serum");
    expect(sys(off1.spy)).toBe(sys(off2.spy));
    expect(withEnv.flags).toEqual(withoutEnv.flags);
    expect(withEnv.pitch).toBe(withoutEnv.pitch);
  });

  it("an OUT-OF-ENUM device/entry is skipped — no directive, no out-of-vocab flag (guarded lookup)", async () => {
    const { brain, spy } = spyBrain(true);
    const d = await brain.decide(
      { cart: "has_items", device: "smart-fridge" as never, entry: "carrier-pigeon" as never },
      "tell me about the serum",
    );
    expect(sys(spy)).not.toMatch(/DEVICE -/);
    expect(sys(spy)).not.toMatch(/ENTRY -/);
    expect(sys(spy)).not.toMatch(/undefined/);
    expect(d.flags.some((f) => f.startsWith("device:") || f.startsWith("entry:"))).toBe(false);
  });

  // Governance-precedent guard (same defect class PR-3/PR-5's persona lookups were hardened against,
  // 2026-08-04, Finding 2): a bare `TABLE[key]` index resolves an Object.prototype member key through the
  // PROTOTYPE CHAIN to an inherited Function. hasOwnProperty is checked BEFORE indexing here too.
  describe("prototype-chain poison keys never resolve through the guarded lookup", () => {
    const POISON_KEYS = ["constructor", "toString", "valueOf", "hasOwnProperty"] as const;

    it.each(POISON_KEYS)("device=%s / entry=%s never injects native code into the prompt, never pushes a non-string flag", async (poisonKey) => {
      const { brain, spy } = spyBrain(true);
      const d = await brain.decide(
        { cart: "has_items", device: poisonKey as never, entry: poisonKey as never },
        "tell me about the serum",
      );
      expect(sys(spy)).not.toMatch(/\[native code\]/);
      for (const f of d.flags) expect(typeof f).toBe("string");
      expect(() => d.flags.filter((f) => f.startsWith("device:") || f.startsWith("entry:"))).not.toThrow();
    });
  });

  it("never threaded into selectPitch — a buy signal still forces pitch=none regardless of device/entry", async () => {
    const { brain, spy } = spyBrain(true);
    const d = await brain.decide(
      { cart: "has_items", device: "mobile", entry: "ad" },
      "I'll take the niacinamide serum, checkout?",
    );
    expect(d.pitch).toBe("none");
    expect(d.flags).toContain("buy_signal");
    // The directives still reach the prompt (voice only)...
    expect(sys(spy)).toMatch(/DEVICE - mobile/);
    expect(sys(spy)).toMatch(/ENTRY - ad/);
    // ...but never resurrect a pitch directive that restraint-after-close already dropped.
    expect(sys(spy)).not.toMatch(/PITCH - cross-sell/);
  });

  // FAIR-1 — the non-negotiable this whole workstream exists to prove: device/entry may ONLY add a voice/
  // format directive. Across EVERY combination of device × entry, pitch selection (and any price/offer
  // surface) must be byte-identical — mirroring brain-persona-style.test.ts's own FAIR-1 test.
  describe("FAIR-1: pitch + price/offer surface is byte-identical across every device × entry value", () => {
    const DEVICES = ["mobile", "tablet", "desktop"] as const;
    const ENTRIES = ["ad", "organic", "direct", "email", "social"] as const;

    it("selectPitch output (via decide()'s public pitch surface) is identical across all device × entry combinations, flag ON", async () => {
      const results: string[] = [];
      for (const device of DEVICES) {
        for (const entry of ENTRIES) {
          const { brain } = spyBrain(true);
          const d = await brain.decide(
            { cart: "has_items", proactivityLevel: "balanced", device, entry },
            "tell me about the serum",
          );
          results.push(d.pitch);
        }
      }
      expect(new Set(results).size).toBe(1); // every device/entry combination lands on the exact same pitch
    });

    it("pitch/offer flag surface is byte-identical between environment-ABSENT and environment-PRESENT, flag ON", async () => {
      const base = { cart: "has_items" as const, proactivityLevel: "balanced" as const };
      const { brain: baseBrain } = spyBrain(true);
      const baseline = await baseBrain.decide(base, "tell me about the serum");
      const offerFlags = (flags: string[]) => flags.filter((f) => f.startsWith("pitch:") || f.startsWith("outbound"));
      for (const device of DEVICES) {
        for (const entry of ENTRIES) {
          const { brain } = spyBrain(true);
          const withEnv = await brain.decide({ ...base, device, entry }, "tell me about the serum");
          expect(withEnv.pitch).toBe(baseline.pitch);
          expect(withEnv.outbound).toBe(baseline.outbound);
          expect(offerFlags(withEnv.flags)).toEqual(offerFlags(baseline.flags));
        }
      }
    });

    it("no directive contains any price/offer/tier language, across every device/entry value", async () => {
      for (const device of DEVICES) {
        const { brain, spy } = spyBrain(true);
        await brain.decide({ cart: "has_items", device }, "tell me about the serum");
        if (deviceLine(spy).length > 0) expect(PRICE_LANGUAGE.test(deviceLine(spy))).toBe(false);
      }
      for (const entry of ENTRIES) {
        const { brain, spy } = spyBrain(true);
        await brain.decide({ cart: "has_items", entry }, "tell me about the serum");
        if (entryLine(spy).length > 0) expect(PRICE_LANGUAGE.test(entryLine(spy))).toBe(false);
      }
    });
  });
});
