import type { Decision } from "@palup/widget-brain";
import type { TelemetryEvent } from "@palup/platform-ports";

// E3 — THE FORWARDING LAYER between `Decision` and the two places a cited product leaves this process:
// the /chat response body, and the per-turn telemetry row.
//
// WHY THESE ARE FUNCTIONS AND NOT INLINE SPREADS IN server.ts. server.ts cannot construct a `Decision`
// that carries these fields at all: its `createBrain` call passes seven positional arguments, so
// PRODUCT_CITATIONS and PRODUCT_CARDS both sit at their `false` defaults and no composition in this repo
// turns them on (that is the E1/E2 structural-inertness pattern, and E3 keeps it). A test driving
// `POST /chat` could therefore only ever exercise the ABSENT case. Extracting the forwarding makes the
// PRESENT case testable — recommendation-telemetry.test.ts drives it with a synthetic `Decision` —
// WITHOUT adding a production seam capable of enabling a posture flag, which is exactly the thing
// docs/HITL-POLICY.md §5 says needs an eval gate, shadow, canary and a named human's approval.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THIS IS RECOMMENDATION TELEMETRY, NOT A BILLING BASIS.
//
// Chaining `recommended -> clicked -> purchased` off `recommendedProductIds` is LAST-TOUCH attribution,
// which ADR-0007 §2 and docs/PRICING.md §2 explicitly forbid as a fee basis ("conservative,
// incrementality-based attribution ... never last-touch inflation ... the billing form of
// engagement-maxxing"). Any fee derived from this field would breach that ADR, and introducing one would
// itself be a money/business-model boundary crossing requiring the Approval Center.
//
// AND IT UNDER-REPORTS. Both outputs inherit every limit of the citation mechanism they are derived
// from: a model that recommends a product in PROSE without copying its tag yields NOTHING here, and
// citations are minted only on the clean sales path, so a proactive exit-intent turn reports nothing at
// all. So the CARDS under-display (a shopper is shown the products the reply cited, not the products it
// recommended) and the TELEMETRY under-counts (absence of an id means "not cited", never "not
// recommended"). A rate computed from either measures citation compliance, not sales behaviour.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
//
// BOTH FUNCTIONS RETURN `{}` — NOT A KEY WITH AN UNDEFINED VALUE — when there is nothing to report. That
// is the whole flag-off guarantee at this layer: spread into the response object or the telemetry event,
// an empty object contributes no key, so the serialized bytes are unchanged
// (widget-backend/test/chat-wire-flag-off.test.ts pins that against a pre-implementation golden). An
// empty ARRAY would be worse than a missing key in both places: on the wire it would make a widget
// render an empty card block, and in telemetry it would look like a MEASURED zero rather than an
// unmeasured turn.

/** What `POST /chat` adds to its response body for a turn that cited products. `{}` when it did not. */
export function recommendationWireFields(
  d: Pick<Decision, "recommendedProducts" | "recommendedProductCards">,
): Pick<Decision, "recommendedProducts" | "recommendedProductCards"> {
  return {
    ...(d.recommendedProducts && d.recommendedProducts.length > 0 ? { recommendedProducts: d.recommendedProducts } : {}),
    ...(d.recommendedProductCards && d.recommendedProductCards.length > 0
      ? { recommendedProductCards: d.recommendedProductCards }
      : {}),
  };
}

/**
 * What the per-turn telemetry row gains for a turn that cited products. `{}` when it did not.
 *
 * IDS ONLY, deliberately: the cards' title/price never enter the telemetry stream. Telemetry is a
 * long-retained, operator-readable measurement surface (ADR-0013), and merchant catalog text in it would
 * be a second copy of the catalog that can go stale — the same reason the retrieval corpus stores ids
 * only (#190).
 */
export function recommendationTelemetryFields(
  d: Pick<Decision, "recommendedProducts">,
): Pick<TelemetryEvent, "recommendedProductIds"> {
  return d.recommendedProducts && d.recommendedProducts.length > 0
    ? { recommendedProductIds: d.recommendedProducts }
    : {};
}
