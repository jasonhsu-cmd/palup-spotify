import { describe, it, expect } from "vitest";
import type { Disposition } from "../src/disposition.js";
import type { FactMetadata, RecalledFact } from "../src/types.js";

// Persona layer PR-0 — the disposition schema, inert (no behavior). Fairness is STRUCTURAL: the
// provenance union has no "inferred" member, so an inferred-willingness-to-pay fact is unrepresentable
// (same narrow-only technique as TenantSensitivityPolicy).
describe("Disposition schema (PR-0, inert)", () => {
  it("constructs stated + observed dispositions across the controlled-vocab axes", () => {
    const observed: Disposition = { axis: "style", value: "researcher", provenance: "observed", confidence: 0.8, sourceQuote: "what actives are in this" };
    const stated: Disposition = { axis: "budget_stated", value: "under-50", provenance: "stated", confidence: 1 };
    expect([observed.provenance, stated.provenance]).toEqual(["observed", "stated"]);
    expect(observed.axis).toBe("style");
  });

  it("provenance has NO 'inferred' member — an inferred-WTP fact is UNREPRESENTABLE (fairness structural, enforced by tsc)", () => {
    // @ts-expect-error — "inferred" is not a valid provenance; the type makes an inferred fact impossible.
    const inferred: Disposition = { axis: "style", value: "deal_seeker", provenance: "inferred", confidence: 0.9 };
    void inferred;
    expect(true).toBe(true);
  });

  it("FactMetadata and RecalledFact carry an optional disposition[]", () => {
    const d: Disposition = { axis: "style", value: "ready", provenance: "observed", confidence: 0.7 };
    const meta: FactMetadata = { text: "prefers fragrance-free", class: "ordinary", expiresAt: "2026-12-31T00:00:00Z", disposition: [d] };
    const fact: RecalledFact = { text: meta.text, class: "ordinary", disposition: [d] };
    expect(fact.disposition?.[0].value).toBe("ready");
  });
});
