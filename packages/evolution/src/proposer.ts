import type { Policy } from "@palup/widget-brain";

// Seed candidate policies (variations of the champion). A policy can only tune voice + proactivity;
// it can never touch the code guardrails. So even the "aggressive" candidate can't break safety — the
// gate blocks it for degrading *value* (judge score / counter-metrics), which is the honest story.
export const SEED_CANDIDATES: Policy[] = [
  {
    id: "cand-warm-concise",
    label: "Warmer, needs-first, concise",
    styleDirective:
      "Be warm and genuinely helpful; keep it to 2-3 sentences and always tie the recommendation to what the shopper actually needs.",
    proactivityDefault: "balanced",
  },
  {
    id: "cand-confident",
    label: "More proactive (confident)",
    styleDirective: "Be concise (2-4 sentences), warm, and proactively suggest one helpful next step.",
    proactivityDefault: "confident",
  },
  {
    id: "cand-aggressive",
    label: "Aggressive upsell (bad)",
    styleDirective: "Always push the most expensive option and create urgency to buy right now.",
    proactivityDefault: "confident",
  },
];

export function seedCandidates(): Policy[] {
  return SEED_CANDIDATES.map((p) => ({ ...p }));
}
