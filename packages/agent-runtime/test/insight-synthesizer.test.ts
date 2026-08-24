import { describe, it, expect } from "vitest";
import { synthesizeInsights, INSIGHT_SYNTHESIZER_AGENT_ID } from "../src/insight-synthesizer.js";
import type { InsightCandidate } from "@palup/platform-ports";

let n = 0;
const newId = () => `id-${++n}`;
const base = { now: "2026-08-24T00:00:00Z", newId, tenantId: "t1" };

describe("synthesizeInsights (conservative grounding)", () => {
  it("records grounded candidates as private synthesized insights and drops sub-floor ones", () => {
    n = 0;
    const candidates: InsightCandidate[] = [
      { category: "customers", text: "First-time buyers convert with a sample add-on", source: "orders", sampleSize: 250 }, // high
      { category: "products", text: "Recovery set has the lowest return rate", source: "returns", sampleSize: 50 },           // medium
      { category: "customers", text: "thin signal", source: "orders", sampleSize: 3 },                                        // dropped
      { category: "voice", text: "  ", source: "chat", sampleSize: 999 },                                                     // dropped (empty)
    ];
    const r = synthesizeInsights({ ...base, candidates });
    expect(r.recorded.map((i) => i.grounding.confidence)).toEqual(["high", "medium"]);
    expect(r.recorded.every((i) => i.origin === "synthesized" && i.tier === "private" && i.tenantId === "t1")).toBe(true);
    expect(r.dropped).toHaveLength(2);
    expect(r.dropped[0].reason).toMatch(/below floor/);
  });

  // B1 (review-mandated blocker fix): "Merchant owns voice — the agent may only PROPOSE voice changes,
  // never silently alter how it talks" (spec §10 W3, CLAUDE.md §3.1). A `category:"voice"` candidate
  // must NEVER be recorded by this synthesizer, no matter how well-grounded it is — even a candidate
  // that clears both the sample-size and confidence floors with real, non-empty text must be dropped,
  // not surfaced as a private insight. Task 6 owns the separate agent-proposes-voice-via-W1 path.
  it("NEVER records a category:voice insight, even when fully grounded above the confidence floor", () => {
    n = 0;
    const candidates: InsightCandidate[] = [
      {
        category: "voice",
        text: "Customers respond better to a warmer, less formal tone in follow-up emails",
        source: "chat",
        sampleSize: 500, // well above INSIGHT_HIGH_CONFIDENCE_MIN_SAMPLE (200) — would grade "high"
      },
    ];
    const r = synthesizeInsights({ ...base, candidates });
    expect(r.recorded).toHaveLength(0);
    expect(r.recorded.some((i) => i.category === "voice")).toBe(false);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0].candidate.category).toBe("voice");
    expect(r.dropped[0].reason).toMatch(/voice/i);
  });

  it("still records a fully-grounded NON-voice candidate (existing behavior preserved)", () => {
    n = 0;
    const candidates: InsightCandidate[] = [
      { category: "policies", text: "Free shipping over $50 reduces cart abandonment", source: "orders", sampleSize: 300 },
    ];
    const r = synthesizeInsights({ ...base, candidates });
    expect(r.recorded).toHaveLength(1);
    expect(r.recorded[0].category).toBe("policies");
    expect(r.recorded[0].grounding.confidence).toBe("high");
    expect(r.dropped).toHaveLength(0);
  });
});

describe("agent identity", () => {
  it("is a stable slug", () => { expect(INSIGHT_SYNTHESIZER_AGENT_ID).toBe("insight_synthesizer"); });
});
