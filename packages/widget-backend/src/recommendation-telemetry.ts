import type { Decision, RecommendedProductCard, SuggestedChip } from "@palup/widget-brain";
import type { TelemetryEvent } from "@palup/platform-ports";
import { cartPermalink } from "./cart-permalink.js";

/**
 * C1 — the wire form of a product card: the neutral brain card PLUS an optional platform cart deep link.
 *
 * `cartUrl` lives HERE, on the wire card, and NEVER on `RecommendedProductCard` (widget-brain), because it
 * is a Shopify-specific URL and the brain is vendor-neutral (grounding-port carries no link either). The
 * neutral opaque `variantId` crosses the port; this widget-backend layer — which alone knows the tenant's
 * shop domain — turns it into the URL. A LINK ONLY: it pre-fills a cart, it never adds-to-cart or purchases
 * on the shopper's behalf (reversible → auto per the C1 governance tag; never auto-purchase).
 */
export interface WireProductCard extends RecommendedProductCard {
  cartUrl?: string;
}

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

/**
 * What `POST /chat` adds to its response body for a turn that cited products. `{}` when it did not.
 *
 * C1 — `cartBase` is the tenant's shop domain (from the merchant resolver). When it is present AND a card
 * carries a `variantId`, the card gains a `cartUrl` cart permalink; otherwise the card is passed through
 * unchanged. `cartPermalink` is fail-safe (undefined on a bad host / non-numeric variant / bad qty), so a
 * malformed or cross-origin URL is never emitted. `cartBase` absent (no domain, or grounding disabled for
 * the tenant) ⇒ no card ever gains a link — the pre-C1 behaviour exactly.
 *
 * Flag-off invariant preserved: cards are absent on every turn today (PRODUCT_CARDS defaults false), so
 * this returns `{}` and the serialized body stays byte-identical — chat-wire-flag-off.test.ts still holds.
 */
export function recommendationWireFields(
  d: Pick<Decision, "recommendedProducts" | "recommendedProductCards">,
  cartBase?: string,
): { recommendedProducts?: string[]; recommendedProductCards?: WireProductCard[] } {
  const cards = d.recommendedProductCards;
  const wireCards: WireProductCard[] | undefined =
    cards && cards.length > 0
      ? cards.map((c) => {
          const cartUrl = cartBase && c.variantId ? cartPermalink(cartBase, c.variantId) : undefined;
          return cartUrl ? { ...c, cartUrl } : c;
        })
      : undefined;
  return {
    ...(d.recommendedProducts && d.recommendedProducts.length > 0 ? { recommendedProducts: d.recommendedProducts } : {}),
    ...(wireCards ? { recommendedProductCards: wireCards } : {}),
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

/**
 * Pillar 3 (opener) — the /chat wire field for the opener's tappable CHIPS. Same forwarding-layer pattern as
 * the E3 helpers above (server.ts cannot construct a `Decision`, so the PRESENT case is testable here):
 * contributes NO key unless the decision actually carried chips, so a turn that mints none — every turn while
 * PROACTIVE_OPENER is off — serializes byte-identically to before this seam existed.
 */
export function suggestedChipsWireField(
  d: Pick<Decision, "suggestedChips">,
): { suggestedChips?: SuggestedChip[] } {
  return d.suggestedChips && d.suggestedChips.length > 0 ? { suggestedChips: d.suggestedChips } : {};
}
