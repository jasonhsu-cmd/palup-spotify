import type { BehavioralCase } from "./schema.js";
import { allPairs, type AxisSpec } from "./pairwise.js";

// Task 10 — Slice B (spec §4/§6): pairwise (all-pairs) coverage over the 6 primary axes, generated
// at runtime (kept OUT of the hand-authored `widget-behavioral.json` per the brief's "runtime-load"
// choice) and concatenated into the corpus by main.ts. Values are the REAL §3 enums, verified against
// packages/widget-brain/src/types.ts:
//   - Relationship (types.ts:16-24): 8 values
//   - Mood (types.ts:7-14): 7 values
//   - PersonaStyle (types.ts:55): 4 values
//   - cart (types.ts:321): "empty" | "has_items" | "high_value"
//   - groundingMode (types.ts:367): "off" | "general" | "full"
//   - ProactivityLevel (types.ts): "cautious" | "balanced" | "confident"
//
// Bar: LIGHT Tier-1 smoke only (spec §4 Slice B: "Lighter Tier-1 bar") — a generic help request run
// through every pairwise combination must not throw. We deliberately do NOT assert `mode`/`escalate`
// here: none of these 6 axes is itself safety/injection/b2b-triggering text, so a stronger assertion
// would just be restating "the message is benign" rather than testing an interaction — and getting it
// wrong would manufacture a false-positive finding. `{ mustNot: [] }` keeps the case genuinely a smoke
// case (loads + decides without throwing) while still exercising the full pairwise grid.
const AXES: AxisSpec = {
  relationship: ["anonymous", "new", "repeat", "vip", "subscriber", "replenishment_due", "lapsed", "one_and_done"],
  mood: ["frustrated", "upset", "anxious", "confused", "skeptical", "neutral", "satisfied"],
  personaStyle: ["ready", "researcher", "deal_seeker", "needs_guidance"],
  cart: ["empty", "has_items", "high_value"],
  groundingMode: ["off", "general", "full"],
  proactivityLevel: ["cautious", "balanced", "confident"],
};

const PAIRWISE_MESSAGE = "Can you help me find something?";

/**
 * Generates the Slice B pairwise corpus: every pair of values across the 6 axes above co-occurs in
 * at least one case (via `allPairs`), each mapped to a single-turn `BehavioralCase`. No stub
 * grounding / no `throwOnGetContext` — these are plain smoke cases on the default (undefined)
 * grounding port, mirroring the un-stubbed cases already in the hand-authored corpus.
 */
export function genPairwiseCases(): BehavioralCase[] {
  // Guard against the zero-value edge (brief): every axis here has a non-empty value list, but assert
  // it so a future edit that accidentally empties one fails loudly instead of silently shrinking the
  // pairwise grid to nothing for that axis.
  for (const [axis, values] of Object.entries(AXES)) {
    if (values.length === 0) throw new Error(`genPairwiseCases: axis ${axis} has no values`);
  }

  const rows = allPairs(AXES);
  return rows.map((row, i) => ({
    id: `pairwise-${String(i).padStart(3, "0")}`,
    family: "pairwise",
    severity: "P2",
    riskClass: "routing",
    signals: { ...row },
    message: PAIRWISE_MESSAGE,
    expect: { mustNot: [] },
  }));
}
