import { describe, it, expect, vi } from "vitest";
import type { ModelPort, ModelRequest } from "@palup/platform-ports";
import { createBrain, DEFAULT_POLICY, StaticGroundingAdapter, MockCommerceAdapter } from "../src/index.js";

// Deferred follow-up #42 from PR-3 — deterministic persona-ROLE directives (SAME flag DISPOSITION_STYLE
// as the persona-STYLE directives in brain-persona-style.test.ts, which this file mirrors). What's locked
// here deterministically is (a) the directive actually reaches the system prompt for the two VOICE-ONLY
// roles (for_self/gift), (b) the matching persona:role_* flag is emitted, (c) the flag OFF (default)
// leaves the prompt/flags byte-identical to before this PR, and (d) NONE of this ever touches
// pitch/selectPitch/outbound (FAIR-1, Inv 10) — a gift shopper gets the exact same PITCH surface as a
// for_self shopper.
//
// NOTE (governance BLOCK closure, Finding 8, 2026-08-04): the eval corpus does NOT supply personaRole —
// PER-1/2/3 (packages/eval/cases/full-corpus.json) carry `"signals": {}`; their role is implied only by
// message TEXT ("something for my dry skin" / "a gift for my sister..." / "do you do wholesale?"), which
// the pre-existing guardrails (B2B keyword, budget/gift regex) and the live judge grade against, not this
// PR's caller-supplied `signals.personaRole` path. This PR's directives are exercised ONLY by the tests
// below and by PRICE_INVARIANCE_PROBES (control-plane/src/counter-metrics.ts), not by the eval corpus.
//
// NOTE (governance BLOCK closure, Finding 3, 2026-08-04): role=b2b no longer takes the voice-only path —
// it now ALSO fires the SAME pre-existing hard-escalation rung (§3.5 brain.ts) the B2B-keyword TEXT
// detector uses, reusing its one reply/flag-set/escalateToHuman rather than adding a parallel path (see
// PER-3 below). PERSONA_ROLE_DIRECTIVE has no b2b entry, so b2b carries no voice-only text to test here.
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

// Isolate JUST the injected persona-role line out of the full system prompt (same reasoning as
// brain-persona-style.test.ts's personaLine: the GROUNDED catalog itself legitimately contains a "%").
const roleLine = (spy: ReturnType<typeof vi.fn>) =>
  sys(spy)
    .split("\n")
    .find((l) => l.startsWith("PERSONA ROLE")) ?? "";

// No price/offer/tier language may appear in the DIRECTIVE ITSELF, ever. Governance BLOCK closure
// (Finding 7, 2026-08-04): widened from the original `/%|\$\d|\btier\b/i` (which missed bare "price"/
// "pricing"/"discount"/"offer"/"deal"/"free shipping" tokens — the original b2b directive text contained
// "pricing" and would have passed the narrower guard). "gift" is deliberately NOT in this list — it is
// the role's own name, legitimately repeated throughout the gift directive, and is not price-adjacent.
const PRICE_LANGUAGE =
  /%|\$\d|\btier\b|\bprice\b|\bpricing\b|\bdiscount\b|\bpromo(?:tion|s)?\b|\bcoupon\b|\bdeal\b|\boffer(?:s|ing)?\b|free shipping/i;

describe("deferred follow-up #42 (PR-3) — persona-ROLE directives (flag DISPOSITION_STYLE)", () => {
  it("PER-1 (for_self): flag ON + personaRole=for_self → neutral-default directive reaches the prompt, persona:role_self flag set", async () => {
    const { brain, spy } = spyBrain(true);
    const d = await brain.decide({ cart: "empty", personaRole: "for_self" }, "something for my dry skin");
    expect(sys(spy)).toMatch(/PERSONA ROLE - for_self/);
    expect(d.flags).toContain("persona:role_self");
    expect(PRICE_LANGUAGE.test(roleLine(spy))).toBe(false);
  });

  it("PER-2 (gift): flag ON + personaRole=gift → the buyer isn't the recipient, gift-appropriate framing, persona:role_gift flag set", async () => {
    const { brain, spy } = spyBrain(true);
    const d = await brain.decide({ cart: "empty", personaRole: "gift" }, "a gift for my sister, sensitive skin, ~$50");
    expect(sys(spy)).toMatch(/PERSONA ROLE - gift/);
    expect(sys(spy)).toMatch(/who it'?s for|recipient/i);
    expect(d.flags).toContain("persona:role_gift");
    expect(PRICE_LANGUAGE.test(roleLine(spy))).toBe(false);
  });

  it("PER-3 (b2b): flag ON + personaRole=b2b, NO B2B keyword in the message → ESCALATES via the SAME §3.5 guardrail rung the TEXT detector uses (governance BLOCK closure, Finding 3, 2026-08-04 — reused, not duplicated)", async () => {
    const { brain, spy } = spyBrain(true);
    const d = await brain.decide({ cart: "empty", personaRole: "b2b" }, "do you carry this in other sizes?");
    expect(d.mode).toBe("support");
    expect(d.escalateToHuman).toBe(true);
    expect(d.pitch).toBe("none");
    expect(d.flags).toEqual(expect.arrayContaining(["persona:b2b", "offer_human", "no_pitch"]));
    // Same guardrail reply the TEXT-keyword detector returns — proves the rung was REUSED, not duplicated.
    expect(d.reply).toMatch(/connect you with a person/i);
    // Short-circuits before any model call — no PERSONA ROLE voice directive is ever generated for b2b.
    expect(spy).not.toHaveBeenCalled();
  });

  it("an OUT-OF-ENUM personaRole is skipped — no 'undefined' directive, no out-of-vocab persona:role_* flag (guarded lookup)", async () => {
    const { brain, spy } = spyBrain(true);
    const d = await brain.decide({ cart: "has_items", personaRole: "bogus_role" as never }, "tell me about the serum");
    expect(sys(spy)).not.toMatch(/PERSONA ROLE/); // no directive appended (lookup was undefined → skipped)
    expect(sys(spy)).not.toMatch(/undefined/); // never appends the literal "undefined"
    expect(d.flags.some((f) => f.startsWith("persona:role"))).toBe(false); // no persona:role_bogus_role flag
  });

  // Governance BLOCK closure (Finding 2, 2026-08-04) — the "guarded lookup" was NOT actually guarded: a
  // bare `TABLE[key]` index resolves an Object.prototype member key through the PROTOTYPE CHAIN to an
  // inherited Function, which is truthy and would (a) inject raw function source
  // ("function Object() { [native code] }") into the system prompt and (b) push a non-string Function
  // into `flags` — the audit-log surface — crashing any `flags.filter(f => f.startsWith(...))` caller
  // (e.g. control-plane's priceSurface(), the FAIR-1 metric computation itself). Fixed with an
  // `Object.prototype.hasOwnProperty.call(TABLE, key)` guard BEFORE indexing (mirroring the guard PR-5's
  // classifyPersonaStyle already used, and PR-7's findRecalledStyleDirective/PR-8's
  // sessionFallbackPersonaStyle).
  describe("governance BLOCK closure — Finding 2: guarded lookup against the PROTOTYPE CHAIN", () => {
    const POISON_KEYS = ["constructor", "toString", "valueOf", "hasOwnProperty"] as const;

    it.each(POISON_KEYS)(
      "personaRole=%s (an Object.prototype member, not a real PersonaRole) never injects native code into the prompt, never pushes a non-string flag, and flags.filter(...).startsWith(...) never throws",
      async (poisonKey) => {
        const { brain, spy } = spyBrain(true);
        const d = await brain.decide({ cart: "has_items", personaRole: poisonKey as never }, "tell me about the serum");
        expect(sys(spy)).not.toMatch(/\[native code\]/);
        expect(sys(spy)).not.toMatch(/PERSONA ROLE/);
        for (const f of d.flags) expect(typeof f).toBe("string");
        expect(() => d.flags.filter((f) => f.startsWith("persona:"))).not.toThrow();
      },
    );
  });

  it("flag OFF (default) — a supplied personaRole is NEVER consumed: no PERSONA ROLE text, no persona:role_* flag (ships inert)", async () => {
    const { brain, spy } = spyBrain(false);
    const d = await brain.decide({ cart: "has_items", personaRole: "gift" }, "tell me about the serum");
    expect(sys(spy)).not.toMatch(/PERSONA ROLE/);
    expect(d.flags.some((f) => f.startsWith("persona:role"))).toBe(false);
  });

  it("flag OFF is byte-identical to a decision with no personaRole at all", async () => {
    const off1 = spyBrain(false);
    const off2 = spyBrain(false);
    const withRole = await off1.brain.decide({ cart: "has_items", personaRole: "b2b" }, "tell me about the serum");
    const withoutRole = await off2.brain.decide({ cart: "has_items" }, "tell me about the serum");
    expect(sys(off1.spy)).toBe(sys(off2.spy));
    expect(withRole.flags).toEqual(withoutRole.flags);
    expect(withRole.pitch).toBe(withoutRole.pitch);
  });

  it("no directive contains any price/offer/tier language, across the voice-only PersonaRole values (b2b escalates instead of carrying a directive — see PER-3 above)", async () => {
    for (const personaRole of ["for_self", "gift"] as const) {
      const { brain, spy } = spyBrain(true);
      await brain.decide({ cart: "has_items", personaRole }, "tell me about the serum");
      expect(roleLine(spy).length).toBeGreaterThan(0); // sanity: the directive actually fired
      expect(PRICE_LANGUAGE.test(roleLine(spy))).toBe(false);
    }
  });

  it("selectPitch output (via decide()'s public pitch surface) is byte-identical across for_self/gift, flag ON — a gift shopper gets the SAME pitch surface as a for_self shopper (b2b excluded: it deliberately escalates instead of pitching — see PER-3 — a real routing divergence, not a fairness leak)", async () => {
    const results: Record<string, string> = {};
    for (const personaRole of ["for_self", "gift"] as const) {
      const { brain } = spyBrain(true);
      const d = await brain.decide({ cart: "has_items", proactivityLevel: "balanced", personaRole }, "tell me about the serum");
      results[personaRole] = d.pitch;
    }
    const values = Object.values(results);
    expect(new Set(values).size).toBe(1); // every voice-only persona role lands on the exact same pitch
  });

  // Governance BLOCK closure (Finding 6, 2026-08-04) — proven test-coverage gap: mutating brain.ts to
  // `if (dispositionStyleEnabled && signals.personaRole) pitch = "upsell";` (a flag-gated leak triggered
  // by ROLE PRESENCE, regardless of which role) passed every existing test, because the only pitch-
  // uniformity assertion compared roles to EACH OTHER (never to a role-ABSENT baseline). This closes that
  // gap: pitch/outbound/offer-flag surface must be IDENTICAL between role-ABSENT and role-PRESENT, flag ON.
  it("Finding 6 closure: pitch/offer surface is byte-identical between role-ABSENT and role-PRESENT, flag ON", async () => {
    const base = { cart: "has_items" as const, proactivityLevel: "balanced" as const };
    const { brain: noRoleBrain } = spyBrain(true);
    const noRole = await noRoleBrain.decide(base, "tell me about the serum");
    const offerFlags = (flags: string[]) => flags.filter((f) => f.startsWith("pitch:") || f.startsWith("outbound"));
    for (const personaRole of ["for_self", "gift"] as const) {
      const { brain } = spyBrain(true);
      const withRole = await brain.decide({ ...base, personaRole }, "tell me about the serum");
      expect(withRole.pitch).toBe(noRole.pitch);
      expect(withRole.outbound).toBe(noRole.outbound);
      expect(offerFlags(withRole.flags)).toEqual(offerFlags(noRole.flags));
    }
  });

  it("never threaded into selectPitch — a buy signal still forces pitch=none regardless of persona role", async () => {
    const { brain, spy } = spyBrain(true);
    const d = await brain.decide({ cart: "has_items", personaRole: "gift" }, "I'll take the niacinamide serum, checkout?");
    expect(d.pitch).toBe("none");
    expect(d.flags).toContain("buy_signal");
    // The persona role directive still reaches the prompt (voice only)...
    expect(sys(spy)).toMatch(/PERSONA ROLE - gift/);
    // ...but never resurrects a pitch directive that restraint-after-close already dropped.
    expect(sys(spy)).not.toMatch(/PITCH - cross-sell/);
  });

  it("a b2b personaRole never diverts or suppresses an otherwise-required support escalation (an open support issue outranks the b2b rung, same precedence as the TEXT-keyword detector)", async () => {
    const { brain, spy } = spyBrain(true);
    const d = await brain.decide({ personaRole: "b2b" }, "I was charged twice for order #2000 — that's a mistake, fix it");
    expect(d.escalateToHuman).toBe(true);
    // Routed by the existing support guardrail (rung 2, above the b2b rung at 3.5), not diverted —
    // the role directive text never even reaches the model call on this path.
    expect(spy).not.toHaveBeenCalled();
  });
});
