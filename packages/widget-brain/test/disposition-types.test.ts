import { describe, it, expect } from "vitest";
import { createBrain, DEFAULT_POLICY, MockModelAdapter, StaticGroundingAdapter } from "../src/index.js";
import type { Signals, PersonaStyle, PersonaRole, BehavioralEvent, MemoryRecallPort, RecalledFact } from "../src/types.js";

// Persona layer PR-0 — the new enums + Signals fields + brain-side opaque RecalledFact.disposition are
// TYPED (so full-corpus.json's personaStyle/behavioral/device keys feed the brain with zero corpus
// edits), and the brain treats disposition as OPAQUE DATA — it never branches on it (PR-0 is inert).

const recallReturning = (facts: RecalledFact[]): MemoryRecallPort => ({ recall: async () => facts });

describe("disposition types (PR-0, inert)", () => {
  it("the new persona enums + Signals fields are assignable (corpus wire-key names)", () => {
    const s: Signals = {
      personaStyle: "researcher",
      personaRole: "gift",
      behavioral: ["dwell", "hesitation", "rage"],
      device: "mobile",
      entry: "ad",
      sessionRecency: "returning",
      csat: 4,
      hasComplaintHistory: false,
      hasReturnHistory: true,
    };
    const style: PersonaStyle = "deal_seeker";
    const role: PersonaRole = "b2b";
    const ev: BehavioralEvent = "pitch_declined";
    expect([s.personaStyle, style, role, ev]).toEqual(["researcher", "deal_seeker", "b2b", "pitch_declined"]);
  });

  it("a RecalledFact carries opaque disposition data on the brain side (bare-string, no memory import)", () => {
    const fact: RecalledFact = { text: "prefers fragrance-free", class: "ordinary", disposition: [{ axis: "style", value: "researcher", provenance: "observed", confidence: 0.8 }] };
    expect(fact.disposition?.[0].axis).toBe("style");
  });

  it("the brain treats a recalled disposition as OPAQUE — identical decision with vs without it (no branching)", async () => {
    const model = new MockModelAdapter();
    const grounding = new StaticGroundingAdapter();
    const sig = { tenantId: "demo", anonId: "guest-pr0" };
    const msg = "what moisturizer do you recommend for dry skin?";
    const withoutDisp = createBrain(model, grounding, DEFAULT_POLICY, undefined, "shopper-demo", recallReturning([{ text: "prefers fragrance-free", class: "ordinary" }]));
    const withDisp = createBrain(model, grounding, DEFAULT_POLICY, undefined, "shopper-demo", recallReturning([{ text: "prefers fragrance-free", class: "ordinary", disposition: [{ axis: "style", value: "researcher", provenance: "observed", confidence: 0.8 }] }]));
    const a = await withoutDisp.decide(sig as never, msg);
    const b = await withDisp.decide(sig as never, msg);
    expect(b).toEqual(a); // disposition changed nothing — the brain never read it (inert)
  });
});
