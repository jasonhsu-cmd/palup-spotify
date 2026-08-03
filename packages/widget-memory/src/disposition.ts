// Persona-disposition schema (shopper-disposition layer, PR-0) — inert until later PRs consume it. A
// disposition is a durable, consent-gated preference/style signal about a shopper that may steer
// SERVICE/GUIDANCE STYLE ONLY (never price/offers/tier — FAIR-1, memory Inv 9).
//
// FAIRNESS IS STRUCTURAL: `provenance` has NO "inferred" member, so an inferred-willingness-to-pay fact
// is UNREPRESENTABLE by construction (the same narrow-only technique as TenantSensitivityPolicy). A
// disposition may only be `stated` (the shopper said it) or `observed` (a concrete in-session behavior),
// never guessed.

export type DispositionAxis = "role" | "style" | "communication" | "budget_stated";

export interface Disposition {
  axis: DispositionAxis;
  /** Controlled vocabulary per axis (e.g. style: researcher|deal_seeker|needs_guidance|ready). */
  value: string;
  /** How we know it. NO "inferred" — fairness is structural, not a runtime check. */
  provenance: "stated" | "observed";
  /** 0..1 confidence. */
  confidence: number;
  /** A short, sanitized span from the shopper's own words, for audit. */
  sourceQuote?: string;
}
