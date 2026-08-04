import { describe, it, expect, vi } from "vitest";
import type { ModelPort, ModelRequest } from "@palup/platform-ports";
import { createBrain, DEFAULT_POLICY, StaticGroundingAdapter, MockCommerceAdapter } from "../src/index.js";

// Deferred follow-up #42 from PR-3 — deterministic persona-ROLE directives (SAME flag DISPOSITION_STYLE
// as the persona-STYLE directives in brain-persona-style.test.ts, which this file mirrors exactly). The
// corpus already supplies `personaRole` (PER-1/2/3: for_self/gift/B2B, docs/design/shopper-widget-eval-
// cases.md) but the brain never consumed it before this PR. What's locked here deterministically is (a)
// the directive actually reaches the system prompt, (b) the matching persona:role_* flag is emitted, (c)
// the flag OFF (default) leaves the prompt/flags byte-identical to before this PR, and (d) NONE of this
// ever touches pitch/selectPitch/outbound (FAIR-1, Inv 10) — a gift shopper gets the exact same PITCH
// surface as a for_self shopper, and a b2b role directive never invents its own escalation authority (the
// existing TEXT-keyword B2B guardrail, `persona:b2b`, is a separate, pre-existing rung that already
// returns before this directive is ever reached whenever it fires).
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

// No price/offer/tier language may appear in the DIRECTIVE ITSELF, ever.
const PRICE_LANGUAGE = /%|\$\d|\btier\b/i;

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

  it("PER-3 (b2b): flag ON + personaRole=b2b → volume/lead-time/spec framing, mentions a human is available, NEVER asserts escalation itself, persona:role_b2b flag set", async () => {
    const { brain, spy } = spyBrain(true);
    const d = await brain.decide({ cart: "empty", personaRole: "b2b" }, "do you carry this in other sizes?");
    expect(sys(spy)).toMatch(/PERSONA ROLE - b2b/);
    expect(sys(spy)).toMatch(/volume|lead time|specification/i);
    expect(d.flags).toContain("persona:role_b2b");
    // The role directive itself never claims escalation is happening — the code-level escalate decision
    // is untouched (see the last test below): this directive only shapes VOICE.
    expect(d.escalateToHuman).toBe(false);
    expect(PRICE_LANGUAGE.test(roleLine(spy))).toBe(false);
  });

  it("an OUT-OF-ENUM personaRole is skipped — no 'undefined' directive, no out-of-vocab persona:role_* flag (guarded lookup)", async () => {
    const { brain, spy } = spyBrain(true);
    const d = await brain.decide({ cart: "has_items", personaRole: "bogus_role" as never }, "tell me about the serum");
    expect(sys(spy)).not.toMatch(/PERSONA ROLE/); // no directive appended (lookup was undefined → skipped)
    expect(sys(spy)).not.toMatch(/undefined/); // never appends the literal "undefined"
    expect(d.flags.some((f) => f.startsWith("persona:role"))).toBe(false); // no persona:role_bogus_role flag
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

  it("no directive contains any price/offer/tier language, across all three PersonaRole values", async () => {
    for (const personaRole of ["for_self", "gift", "b2b"] as const) {
      const { brain, spy } = spyBrain(true);
      await brain.decide({ cart: "has_items", personaRole }, "tell me about the serum");
      expect(roleLine(spy).length).toBeGreaterThan(0); // sanity: the directive actually fired
      expect(PRICE_LANGUAGE.test(roleLine(spy))).toBe(false);
    }
  });

  it("selectPitch output (via decide()'s public pitch surface) is byte-identical across every PersonaRole, flag ON — a gift shopper gets the SAME pitch surface as a for_self shopper", async () => {
    const results: Record<string, string> = {};
    for (const personaRole of ["for_self", "gift", "b2b"] as const) {
      const { brain } = spyBrain(true);
      const d = await brain.decide({ cart: "has_items", proactivityLevel: "balanced", personaRole }, "tell me about the serum");
      results[personaRole] = d.pitch;
    }
    const values = Object.values(results);
    expect(new Set(values).size).toBe(1); // every persona role lands on the exact same pitch
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

  it("a b2b personaRole never diverts or suppresses an otherwise-required support escalation (the TEXT-keyword B2B guardrail wins first, unaffected by this directive)", async () => {
    const { brain, spy } = spyBrain(true);
    const d = await brain.decide({ personaRole: "b2b" }, "I was charged twice for order #2000 — that's a mistake, fix it");
    expect(d.escalateToHuman).toBe(true);
    // Routed by the existing support guardrail, not by the new role directive — the role directive text
    // never even reaches the model call on this path (support.ts's own reply, no groundedMessages system
    // prompt call recorded on the spy).
    expect(spy).not.toHaveBeenCalled();
  });
});
