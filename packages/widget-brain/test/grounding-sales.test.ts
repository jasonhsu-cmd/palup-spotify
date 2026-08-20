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
    // AVAILABILITY — three requirements, asserted separately so none can regress behind the others.
    //
    // History: this line once opened "All catalog items are in stock" — an unconditional factual claim
    // made to every shopper on every turn while GroundingPort carried no stock field at all (#157 removed
    // it). #157 replaced it with a blanket ban on ever discussing availability, which was honest but meant
    // the agent could not answer the most ordinary pre-purchase question. Availability is now genuinely
    // GROUNDED (Product.availableForSale), so the ban is deliberately narrowed to what remains unknowable.
    //
    // What must hold now:
    //  1. the original false claim never returns;
    //  2. availability may be stated ONLY from an explicit catalog line — never inferred from listing;
    //  3. stock LEVELS and urgency remain forbidden outright, INCLUDING when an item is available (the
    //     tempting case, and the one a conversion-maximising candidate would reach for — §8a inv 11).
    // The previous single-regex assertion would have passed even if the anti-urgency clause had been
    // dropped, as long as that one phrase survived; these three cannot be satisfied by wording alone.
    expect(s).not.toMatch(/All catalog items are in stock/);
    expect(s).toMatch(/state it ONLY from an item's explicit 'Availability:' line/);
    expect(s).toMatch(/never infer availability from the item merely being listed/);
    expect(s).toMatch(/STOCK LEVELS are never in the CATALOG/);
    expect(s).toMatch(/never use availability to manufacture urgency or scarcity/);
    expect(s).toMatch(/not even when an item IS available/);
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

  it("a skeptic efficacy question adds an evidence + AI-disclosure steer", async () => {
    const { brain, spy } = spyBrain();
    await brain.decide({ cart: "empty" }, "does this actually work or is it just hype?");
    expect(sys(spy)).toMatch(/SKEPTIC POLICY/);
  });

  it("a stated gift budget caps recommendations in the prompt", async () => {
    const { brain, spy } = spyBrain();
    await brain.decide({ cart: "empty" }, "a gift for my sister with sensitive skin, around $50");
    expect(sys(spy)).toMatch(/at or below \$50/);
  });

  it("an idle browser gets no pitch and a light-greeting steer", async () => {
    const { brain, spy } = spyBrain();
    const d = await brain.decide({ cart: "empty" }, "just browsing, thanks");
    expect(d.pitch).toBe("none");
    expect(d.flags).toContain("browsing");
    expect(sys(spy)).toMatch(/BROWSING/);
  });

  // F7 — a plain ingredient/composition question is a catalog-fact lookup, not a sales opening: it
  // must still be ANSWERED (grounded from the catalog, mode stays "sales" — see classifySupportIntent's
  // own comment on why this deliberately does NOT route to support) but must carry NO pitch, since a
  // shopper checking composition/allergens is not signaling buying intent.
  it("an ingredient question gets no pitch (F7)", async () => {
    const { brain, spy } = spyBrain();
    const d = await brain.decide({}, "What ingredients are in the daily moisturizer?");
    expect(d.mode).toBe("sales");
    expect(d.pitch).toBe("none");
    expect(d.flags).toContain("ingredient_q");
    expect(sys(spy)).not.toMatch(/PITCH - guided recommendation/);
  });

  it("a 'does this contain X' composition question gets no pitch (F7)", async () => {
    const { brain } = spyBrain();
    const d = await brain.decide({}, "Does this contain retinol?");
    expect(d.mode).toBe("sales");
    expect(d.pitch).toBe("none");
    expect(d.flags).toContain("ingredient_q");
  });

  it("a deliberating question is NOT a buy signal (false-positive boundary)", async () => {
    const { brain } = spyBrain();
    const d = await brain.decide({ cart: "has_items" }, "should I buy it, or is the other one better?");
    expect(d.flags).not.toContain("buy_signal");
  });

  it("a bare price mention is NOT a budget ceiling (false-positive boundary)", async () => {
    const { brain, spy } = spyBrain();
    await brain.decide({ cart: "empty" }, "is the $18 cleanser any good?");
    expect(sys(spy)).not.toMatch(/at or below \$/);
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
    // "full" used to say the model "may reference a current competitor fact ONLY if you can cite a
    // source". No web/search/retrieval port exists in platform-ports, so no citable current source can
    // exist and that reduced to self-certification — shipped to every shopper, since "full" is the
    // DEFAULT mode. It now states its real capability. Restore a citation assertion here in the same PR
    // that lands a retrieval port (Tier 3, docs/design/shopper-widget.md:118-121).
    { mode: "full" as const, expect: /NO web access or live sources/ },
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

  // F9 (repro): the most natural competitor-comparison phrasing literally contains the word
  // "competitor" — and UNKNOWN_FACT's bare "competitor" trigger (honest_uncertainty, step 3 in
  // decide()) sits ABOVE this groundingMode-aware block, so it intercepted the message first and
  // silently defeated the merchant's off/general/full policy (no `competitor:<mode>` flag ever
  // emitted, and the model was never even called — model stays "guardrail", not the real model).
  // This must resolve like the "Brand Y" cases above, not like a generic unverifiable-fact question.
  it("F9: a comparison naming 'competitors' (not a specific rival) still reaches the groundingMode block", async () => {
    const { brain, spy } = spyBrain();
    const d = await brain.decide({ groundingMode: "general" }, "How do you compare to your competitors?");
    expect(d.flags).toContain("competitor:general");
    expect(d.flags).not.toContain("honest_uncertainty");
    expect(d.model).toBe("spy"); // reached the real model call, not the guardrail short-circuit
    expect(sys(spy)).toMatch(/GENERAL comparison/);
  });

  // F9 boundary: a message asking for a specific, volatile competitor FACT (price) must still be
  // caught by honest_uncertainty — the fix only redirects generic comparison phrasing, it must not
  // let the agent try to answer an unverifiable price question.
  it("F9 boundary: a competitor PRICE question still hits honest_uncertainty, unchanged", async () => {
    const { brain } = spyBrain();
    const d = await brain.decide({}, "what's the competitor price on this?");
    expect(d.flags).toContain("honest_uncertainty");
    expect(d.flags).not.toContain("competitor:full");
    expect(d.pitch).toBe("none");
  });
});
