import { describe, it, expect, vi } from "vitest";
import type { ModelPort, ModelRequest } from "@palup/platform-ports";
import { createBrain, DEFAULT_POLICY, StaticGroundingAdapter, MockCommerceAdapter } from "../src/index.js";

// Shopper-disposition program PR-3 — deterministic persona-style directives (flag DISPOSITION_STYLE).
// PER-4/5/6/7 (docs/design/shopper-widget-eval-cases.md) map 1:1 onto the four PersonaStyle values:
// PER-4=ready, PER-5=researcher, PER-6=deal_seeker, PER-7=needs_guidance. No classifier yet (PR-5) — the
// brain only CONSUMES a supplied signals.personaStyle. Same spy-model pattern as grounding-sales.test.ts:
// the reply CONTENT is the live model's job (judged live by eval:full); what's locked here deterministically
// is (a) the directive actually reaches the system prompt, (b) the matching persona:* flag is emitted, (c)
// the flag OFF (default) leaves the prompt/flags byte-identical to before this PR, and (d) NONE of this ever
// touches pitch/selectPitch/outbound (FAIR-1, Inv 10).
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

// Isolate JUST the injected persona-style line out of the full system prompt. Needed because the
// GROUNDED catalog itself legitimately contains a "%" (e.g. "Niacinamide 10% Serum", static-grounding.ts)
// unrelated to any persona/price coupling — so a price-language check must scope to the directive text
// itself, not the whole prompt, to avoid a false positive against the merchant's own product data.
const personaLine = (spy: ReturnType<typeof vi.fn>) =>
  sys(spy)
    .split("\n")
    .find((l) => l.startsWith("PERSONA STYLE")) ?? "";

// No price/offer/tier language may appear in the DIRECTIVE ITSELF, ever — checked against the isolated
// persona-style line on every case below (not just spot-checked), so a future wording edit can't
// reintroduce it. (deal_seeker's directive legitimately says the WORDS "discount"/"coupon"/"promo" in a
// NEGATION ["NEVER invent...a discount, coupon, or promo"], so those bare words are not banned here —
// only a live "%"/"$N" price token is, which the negation prose never carries.)
const PRICE_LANGUAGE = /%|\$\d|\btier\b/i;

describe("PR-3 — persona-style directives (flag DISPOSITION_STYLE)", () => {
  it("PER-4 (ready): flag ON + personaStyle=ready → efficient-close directive reaches the prompt, persona:ready flag set, no added pitch language", async () => {
    const { brain, spy } = spyBrain(true);
    const d = await brain.decide({ cart: "has_items", personaStyle: "ready" }, "tell me about the serum");
    expect(sys(spy)).toMatch(/PERSONA STYLE - ready to buy/);
    expect(sys(spy)).toMatch(/efficient/i);
    expect(d.flags).toContain("persona:ready");
    expect(PRICE_LANGUAGE.test(personaLine(spy))).toBe(false);
  });

  it("PER-5 (researcher): flag ON + personaStyle=researcher → names actives/limits, no hype, persona:researcher flag set", async () => {
    const { brain, spy } = spyBrain(true);
    const d = await brain.decide({ cart: "empty", personaStyle: "researcher" }, "tell me about the serum");
    expect(sys(spy)).toMatch(/PERSONA STYLE - researcher/);
    expect(sys(spy)).toMatch(/active ingredients\/concentrations/);
    expect(sys(spy)).toMatch(/no hype/i);
    expect(d.flags).toContain("persona:researcher");
    expect(PRICE_LANGUAGE.test(personaLine(spy))).toBe(false);
  });

  it("PER-6 (deal_seeker): flag ON + personaStyle=deal_seeker → only grounded merchant-approved promos, never invent, persona:deal_seeker flag set", async () => {
    const { brain, spy } = spyBrain(true);
    const d = await brain.decide({ cart: "has_items", personaStyle: "deal_seeker" }, "tell me about the serum");
    expect(sys(spy)).toMatch(/PERSONA STYLE - deal seeker/);
    expect(sys(spy)).toMatch(/NEVER invent, imply, or promise a discount, coupon, or promo/);
    expect(d.flags).toContain("persona:deal_seeker");
    // The directive itself may discuss "discount/coupon/promo" only in the NEGATIVE (forbidding them) —
    // it must never contain a live "%"/"$N" price token or tier language.
    expect(PRICE_LANGUAGE.test(personaLine(spy))).toBe(false);
  });

  it("PER-7 (needs_guidance): flag ON + personaStyle=needs_guidance → one discovery question, don't over-steer, persona:needs_guidance flag set", async () => {
    const { brain, spy } = spyBrain(true);
    const d = await brain.decide({ cart: "empty", personaStyle: "needs_guidance" }, "no idea where to start");
    expect(sys(spy)).toMatch(/PERSONA STYLE - needs guidance/);
    expect(sys(spy)).toMatch(/ONE short, focused discovery question/);
    expect(sys(spy)).toMatch(/over-steer/);
    expect(d.flags).toContain("persona:needs_guidance");
    expect(PRICE_LANGUAGE.test(personaLine(spy))).toBe(false);
  });

  it("an OUT-OF-ENUM personaStyle is skipped — no 'undefined' directive, no out-of-vocab persona flag (guarded lookup)", async () => {
    const { brain, spy } = spyBrain(true);
    const d = await brain.decide({ cart: "has_items", personaStyle: "bogus_style" as never }, "tell me about the serum");
    expect(sys(spy)).not.toMatch(/PERSONA STYLE/); // no directive appended (lookup was undefined → skipped)
    expect(sys(spy)).not.toMatch(/undefined/); // never appends the literal "undefined"
    expect(d.flags.some((f) => f.startsWith("persona:"))).toBe(false); // no persona:bogus_style flag
  });

  it("flag OFF (default) — a supplied personaStyle is NEVER consumed: no PERSONA STYLE text, no persona:* flag (ships inert)", async () => {
    const { brain, spy } = spyBrain(false);
    const d = await brain.decide({ cart: "has_items", personaStyle: "deal_seeker" }, "tell me about the serum");
    expect(sys(spy)).not.toMatch(/PERSONA STYLE/);
    expect(d.flags.some((f) => f.startsWith("persona:"))).toBe(false);
  });

  it("flag OFF is byte-identical to a decision with no personaStyle at all", async () => {
    const off1 = spyBrain(false);
    const off2 = spyBrain(false);
    const withPersona = await off1.brain.decide({ cart: "has_items", personaStyle: "researcher" }, "tell me about the serum");
    const withoutPersona = await off2.brain.decide({ cart: "has_items" }, "tell me about the serum");
    expect(sys(off1.spy)).toBe(sys(off2.spy));
    expect(withPersona.flags).toEqual(withoutPersona.flags);
    expect(withPersona.pitch).toBe(withoutPersona.pitch);
  });

  it("no directive contains any price/offer/tier language, across all four PersonaStyle values", async () => {
    for (const personaStyle of ["ready", "researcher", "deal_seeker", "needs_guidance"] as const) {
      const { brain, spy } = spyBrain(true);
      await brain.decide({ cart: "has_items", personaStyle }, "tell me about the serum");
      expect(personaLine(spy).length).toBeGreaterThan(0); // sanity: the directive actually fired
      expect(PRICE_LANGUAGE.test(personaLine(spy))).toBe(false);
    }
  });

  it("selectPitch output (via decide()'s public pitch surface) is byte-identical across every PersonaStyle, flag ON", async () => {
    const results: Record<string, string> = {};
    for (const personaStyle of ["ready", "researcher", "deal_seeker", "needs_guidance"] as const) {
      const { brain } = spyBrain(true);
      const d = await brain.decide({ cart: "has_items", proactivityLevel: "balanced", personaStyle }, "tell me about the serum");
      results[personaStyle] = d.pitch;
    }
    const values = Object.values(results);
    expect(new Set(values).size).toBe(1); // every persona lands on the exact same pitch
  });

  it("never threaded into selectPitch — a buy signal still forces pitch=none regardless of persona", async () => {
    const { brain, spy } = spyBrain(true);
    const d = await brain.decide({ cart: "has_items", personaStyle: "deal_seeker" }, "I'll take the niacinamide serum, checkout?");
    expect(d.pitch).toBe("none");
    expect(d.flags).toContain("buy_signal");
    // The persona directive still reaches the prompt (voice only)...
    expect(sys(spy)).toMatch(/PERSONA STYLE - deal seeker/);
    // ...but never resurrects a pitch directive that restraint-after-close already dropped.
    expect(sys(spy)).not.toMatch(/PITCH - cross-sell/);
  });
});
