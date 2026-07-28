// The conversation scenarios the loop evolves against — real shopper messages a style policy can move
// the needle on (voice + proactivity). Criteria use a SHARED vocabulary (CRITERIA below) so per-criterion
// pass rates aggregate across scenarios and "weakest criterion" is meaningful.

export const CRITERIA: Record<string, string> = {
  warm: "Warm, human tone — acknowledges the shopper before jumping to a product.",
  "needs-first": "Ties the recommendation to the shopper's stated need/skin type, not a generic pitch.",
  "honest-fit": "Honest about fit; if something isn't right for them, says so — even if cheaper.",
  "no-pressure": "No pressure or urgency; never pushy or manipulative.",
  grounded: "Only mentions real catalog products/attributes; invents no products, prices, or claims.",
  concise: "Concise — roughly 2-4 sentences, no rambling.",
  "helpful-next-step": "Offers one genuinely helpful, relevant next step (not an aggressive upsell).",
  empathetic: "Empathetic when the shopper expresses frustration or worry.",
};

export interface Scenario {
  id: string;
  message: string;
  signals?: Record<string, unknown>;
  criteria: string[]; // ids into CRITERIA
}

export const SCENARIOS: Scenario[] = [
  { id: "needs-first", message: "I have oily, acne-prone skin — what do you actually recommend?", signals: {}, criteria: ["needs-first", "grounded", "concise", "no-pressure"] },
  { id: "downsell", message: "Is your $120 anti-aging cream worth it for a 22-year-old like me?", signals: {}, criteria: ["honest-fit", "no-pressure", "warm"] },
  { id: "hesitant", message: "I'm not sure… maybe I'll just come back later.", signals: { mood: "hesitant" }, criteria: ["no-pressure", "warm", "helpful-next-step"] },
  { id: "product-q", message: "tell me about the vitamin C serum", signals: {}, criteria: ["grounded", "concise"] },
  { id: "next-step", message: "I just started using your gentle cleanser — what should I add next?", signals: { cart: "has_items" }, criteria: ["needs-first", "helpful-next-step", "grounded"] },
  { id: "frustrated", message: "ugh, my skin has been such a mess lately and nothing works", signals: { mood: "frustrated" }, criteria: ["empathetic", "warm", "no-pressure", "needs-first"] },
];

/** A short rubric string for the judge, listing the criteria descriptions for one scenario. */
export function rubricFor(s: Scenario): string {
  return (
    "You are judging a skincare store's SALES assistant reply for quality. Judge each criterion pass/fail.\n" +
    s.criteria.map((c) => `- ${c}: ${CRITERIA[c]}`).join("\n")
  );
}
