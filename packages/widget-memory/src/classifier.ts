// ADR-0015 "Fact sensitivity" + Inv 11: every candidate fact is classified BEFORE any write. Art-9
// categories (health, allergy, medical, pregnancy, biometric, genetic, sexual-orientation, …) are
// special-category by CONSERVATIVE DEFAULT; a per-tenant/industry policy may only NARROW what is
// remembered (drop a category entirely), never reclassify special-category data as ordinary. The
// keyword map below is seeded from widget-brain's existing safety lexicon (brain.ts `SAFETY` groups —
// product_safety/medical — and `allergenScan`'s allergen labels), the same terms that trigger the
// REACTIVE safety branch there. That branch is memory-independent (Inv 10: the safety answer needs no
// consent and stores nothing) — this is a SEPARATE, governed map that only decides whether a distilled
// fact may be durably REMEMBERED, and under which consent tier. Matching mirrors brain.ts's own
// `classifySafety` (plain substring match over a lower-cased string) for the same low-false-negative,
// deterministic bias — a false positive here just asks for one extra consent tier, never leaks data.

export type FactClass = "ordinary" | "special";

export interface FactClassification {
  class: FactClass;
  /** Whether this fact should actually be persisted. `false` only when a tenant policy has narrowed
   * (dropped) its category — the class itself is never downgraded by narrowing. */
  remember: boolean;
}

/**
 * A per-tenant/industry sensitivity policy (ADR-0015 Inv 11: "governed, per-industry-configurable
 * policy with a conservative default"). `dropCategories` may ONLY remove a category from being
 * remembered (`remember: false`) — there is deliberately no field that could reclassify a special
 * category as ordinary; the type surface itself makes that impossible to express.
 */
export interface TenantSensitivityPolicy {
  dropCategories?: string[];
}

// Category key -> substrings that match it (lower-cased, plain `includes`, same style as
// brain.ts's SAFETY/classifySafety). Category keys are the `dropCategories` narrowing vocabulary.
const SPECIAL_CATEGORIES: Record<string, string[]> = {
  // seeded from brain.ts SAFETY "product_safety" + allergenScan's allergen labels
  allergy: ["allerg", "tree-nut", "tree nut", "peanut", "gluten", "wheat", "shellfish", "soy"],
  // seeded from brain.ts SAFETY "product_safety" (skin/reaction terms) + "medical"
  health_reaction: [
    "rash", "reaction", "reacted", "broke out", "breaking out", "irritat", "swelling", "swollen",
    "sting", "hives", "peeling", "flaking", "blister", "burn", "eczema", "rosacea", "infection",
    "medication", "prescription", "tretinoin", "diagnos", "cure",
  ],
  pregnancy: ["pregnan"],
  // boundary/ambiguous dermatological mentions — conservative default (Inv 11), see classifier tests
  skin_sensitivity: ["sensitive skin"],
  biometric: ["fingerprint", "face scan", "biometric"],
  genetic: ["genetic test", "dna test", "genetic condition"],
  sexual_orientation: ["sexual orientation", "lesbian", "bisexual", "transgender"],
};

function matchCategory(text: string): string | undefined {
  const t = text.toLowerCase();
  for (const [category, terms] of Object.entries(SPECIAL_CATEGORIES)) {
    if (terms.some((term) => t.includes(term))) return category;
  }
  return undefined;
}

/**
 * Classifies a distilled fact as `"ordinary"` or `"special"`. Unmatched text defaults to `"ordinary"`;
 * ANY match against the conservative special-category map wins (ambiguous/boundary text like "sensitive
 * skin" is intentionally seeded into the map so it classifies special, per Inv 11's conservative bias).
 * `policy.dropCategories` can stop a matched category from being remembered (`remember: false`) — it
 * can NEVER change `class` back to `"ordinary"` (Inv 11: narrow-only).
 */
export function classifyFact(text: string, policy?: TenantSensitivityPolicy): FactClassification {
  const category = matchCategory(text);
  if (!category) return { class: "ordinary", remember: true };
  const dropped = policy?.dropCategories?.includes(category) ?? false;
  return { class: "special", remember: !dropped };
}
