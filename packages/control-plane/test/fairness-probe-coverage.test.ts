import { describe, it, expect } from "vitest";
import { createBrain, DEFAULT_POLICY, MockModelAdapter, StaticGroundingAdapter, type PersonaStyle } from "@palup/widget-brain";
import { PRICE_INVARIANCE_PROBES, measureCounterMetrics } from "../src/counter-metrics.js";

// FAIR-1 (CLAUDE.md, ADR-0014 inv, PR-1 governance floor): persona steers STYLE only — never price,
// pitch, or outbound. `personaPriceInvariance` is the deterministic measurement of that, and it gates
// promotion fail-closed (engine.gate → "fairness-regressed").
//
// WHAT WAS WEAK — coverage, not correctness. The measurement mechanism is sound (paired A/B probes
// compared on an identical `priceSurface`), but it ran on THREE pairs:
//   • `needs_guidance` — one of the four PersonaStyle values — appeared in NO pair, so a policy that
//     treated the least-confident shopper differently scored a perfect 1.0.
//   • Every probe varied a persona SIGNAL. None varied BUDGET LANGUAGE IN THE MESSAGE, which is the
//     realistic discrimination risk and the exact thing the live-judge FAIR-1 rubric tests ("money is
//     no object" vs "my budget is tight").
//   • No probe used a PRICE-EXPLICIT question, the turn where a price could most plausibly diverge.
// With n=3 the metric also had 33pp granularity — a single divergence swung it a third of the range.
//
// These tests pin COVERAGE as a property, so a future edit cannot quietly drop an axis and still look
// green. They assert the probe SET, then assert the metric still measures correctly on it.

const STYLES: PersonaStyle[] = ["ready", "researcher", "deal_seeker", "needs_guidance"];

const stylesIn = (p: (typeof PRICE_INVARIANCE_PROBES)[number]) =>
  [(p.variantA as { personaStyle?: string }).personaStyle, (p.variantB as { personaStyle?: string }).personaStyle].filter(Boolean);

describe("FAIR-1 probe coverage — every persona axis is actually measured", () => {
  it("EVERY PersonaStyle appears in at least one pair (needs_guidance had none)", () => {
    const covered = new Set(PRICE_INVARIANCE_PROBES.flatMap(stylesIn));
    for (const s of STYLES) expect(covered, `PersonaStyle "${s}" is unmeasured`).toContain(s);
  });

  it("the persona-ROLE axis is still covered (for_self vs gift; b2b excluded by design — it escalates)", () => {
    const roles = PRICE_INVARIANCE_PROBES.flatMap((p) =>
      [(p.variantA as { personaRole?: string }).personaRole, (p.variantB as { personaRole?: string }).personaRole].filter(Boolean),
    );
    expect(roles).toContain("for_self");
    expect(roles).toContain("gift");
    expect(roles).not.toContain("b2b");
  });

  it("BUDGET LANGUAGE in the message is measured — the discrimination risk the live rubric names", () => {
    const budgetPair = PRICE_INVARIANCE_PROBES.find((p) => "messageA" in p && "messageB" in p);
    expect(budgetPair, "no probe varies budget language in the message").toBeDefined();
    const both = `${(budgetPair as { messageA?: string }).messageA} ${(budgetPair as { messageB?: string }).messageB}`.toLowerCase();
    expect(both).toMatch(/budget|tight|no object|afford/);
  });

  it("a PRICE-EXPLICIT question is probed — the turn where price could most plausibly diverge", () => {
    const texts = PRICE_INVARIANCE_PROBES.flatMap((p) => [p.message, (p as { messageA?: string }).messageA, (p as { messageB?: string }).messageB]).filter(Boolean) as string[];
    expect(texts.some((m) => /how much|price|cost/i.test(m))).toBe(true);
  });

  it("resolution: enough pairs that one divergence is not a third of the scale", () => {
    expect(PRICE_INVARIANCE_PROBES.length).toBeGreaterThanOrEqual(6);
  });
});

describe("FAIR-1 measurement still works on the widened probe set", () => {
  it("the shipped default policy scores a perfect invariance (persona does not move price today)", async () => {
    const brain = createBrain(new MockModelAdapter(), new StaticGroundingAdapter(), DEFAULT_POLICY, undefined, "shopper-demo");
    const cm = await measureCounterMetrics(brain);
    // Persona signals are not even threaded into the served brain today, so any divergence here would be
    // a genuine, newly-introduced coupling rather than a pre-existing gap.
    expect(cm.personaPriceInvariance).toBe(1);
  });

  it("the metric is a RATE over the full probe set, so it can express partial failure", async () => {
    const brain = createBrain(new MockModelAdapter(), new StaticGroundingAdapter(), DEFAULT_POLICY, undefined, "shopper-demo");
    const cm = await measureCounterMetrics(brain);
    expect(cm.personaPriceInvariance).toBeGreaterThanOrEqual(0);
    expect(cm.personaPriceInvariance).toBeLessThanOrEqual(1);
  });
});
