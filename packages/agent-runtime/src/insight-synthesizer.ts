import { gradeInsight, type InsightCandidate, type LearnedInsight } from "@palup/platform-ports";

// W3 Task 5: the governed insight-synthesizer producer. A pure function that turns raw observation
// signals (`InsightCandidate[]`) into candidates for the tenant's private LEARNED layer, runs each
// through the conservative `gradeInsight` grounding gate (Task 1), and records ONLY the grounded ones
// — dropping the rest honestly, with a reason the caller may audit. This is a governed RUN-TIME agent
// (CLAUDE.md §2); its prod promotion (eval gate + evolution pipeline) is a deferred human gate — on
// staging it runs like any other agent via the trigger route in merchant-backend.
//
// B1 (review-mandated blocker fix): "Merchant owns voice — the agent may only PROPOSE voice changes,
// never silently alter how it talks" (spec §10 W3, CLAUDE.md §3.1). A `category:"voice"` candidate is
// therefore EXCLUDED here entirely — dropped BEFORE grading even runs, never recorded, regardless of
// how well-grounded it is. Task 6 owns the separate agent-proposes-voice-via-W1 path (not built here;
// do not attempt to call into it from this producer).

/** The insight synthesizer agent's stable id — the `actor` on every insight it records + audits. */
export const INSIGHT_SYNTHESIZER_AGENT_ID = "insight_synthesizer";

export interface SynthesisInput { candidates: InsightCandidate[]; now: string; newId: () => string; tenantId: string; }
export interface SynthesisResult { recorded: LearnedInsight[]; dropped: Array<{ candidate: InsightCandidate; reason: string }>; }

/** Pure: run every candidate through the conservative grounding gate. Only `surface:true` candidates
 *  become private `synthesized` insights (confidence from the gate) — EXCEPT `category:"voice"`,
 *  which is always dropped regardless of grounding (B1, see header). Everything else dropped is
 *  dropped WITH a reason — the caller may audit the drop, but nothing sub-floor (or voice) is ever
 *  surfaced (spec §10: a wrong insight acted on burns trust; a silently-altered voice burns it worse).
 *  No `Date.now()`/id generation in here — both are injected. */
export function synthesizeInsights(input: SynthesisInput): SynthesisResult {
  const recorded: LearnedInsight[] = [];
  const dropped: SynthesisResult["dropped"] = [];
  for (const candidate of input.candidates) {
    if (candidate.category === "voice") {
      dropped.push({ candidate, reason: "voice insights are never auto-recorded — merchant owns voice; the agent may only propose (a separate, later path)" });
      continue;
    }
    const verdict = gradeInsight(candidate);
    if (!verdict.surface) { dropped.push({ candidate, reason: verdict.reason }); continue; }
    recorded.push({
      id: input.newId(), tenantId: input.tenantId, category: candidate.category, tier: "private",
      origin: "synthesized", text: candidate.text.trim(),
      grounding: { source: candidate.source, sampleSize: candidate.sampleSize, confidence: verdict.confidence },
      pinned: false, createdAt: input.now, updatedAt: input.now,
    });
  }
  return { recorded, dropped };
}
