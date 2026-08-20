// Layer-2 judge ground truth — extracted so it is unit-testable independent of
// `layer2-judge-run.ts` (which runs its `main()` on import, exactly like `judge-run.ts`).
//
// WHY THIS EXISTS: `packages/eval/src/judge-run.ts` (Layer 1) injects the merchant's real catalog
// into the judge rubric via `grounding.getContext()`, so its judge can tell a real fact from an
// invented one. The Layer-2 judge (`layer2-judge-run.ts`) judges REAL prose captured from staging
// (`reports/layer2-live-run.json`) and had no equivalent — it judged grounding/fabrication with no
// ground truth at all, and repeatedly flagged genuine catalog products as "fabricated" purely
// because it could not verify them (see docs/widget-test-report.md "Judge-harness limitation").
//
// THE FIX: each captured turn's `/chat` response already carries `recommendedProductCards` —
// the SAME real merchant products (with real Shopify `productId`/`variantId`) the agent's own
// citation mechanism resolved and grounded the reply on (`RecommendedProductCard`,
// packages/widget-brain/src/types.ts). That IS ground truth for "this product is real", exactly
// as authoritative as the Layer-1 catalog injection, just sourced from the live turn instead of a
// fresh `getContext()` call. Building a rubric addendum from it and cross-checking is enough to
// stop the judge from flagging a product that the case's own cards already vouch for.
export type MinimalProductCard = { productId?: unknown; title?: unknown; price?: unknown };
export type MinimalChatResponse = { recommendedProductCards?: unknown };
export type MinimalTurnRecord = { response?: MinimalChatResponse };

/**
 * Collect the de-duplicated set of real products cited across a case run's turns, formatted as a
 * rubric addendum. Returns "" (not injected) when no turn carried any cards — the common case for
 * non-grounding cases, and for cases run before PRODUCT_CARDS was enabled — so the rubric is left
 * byte-for-byte unchanged rather than padded with an empty ground-truth block.
 */
export function buildLayer2GroundTruth(turnRecords: MinimalTurnRecord[]): string {
  const byId = new Map<string, { title: string; price: string }>();
  for (const t of turnRecords) {
    const cards = t.response?.recommendedProductCards;
    if (!Array.isArray(cards)) continue;
    for (const c of cards as MinimalProductCard[]) {
      const id = c?.productId;
      if (typeof id !== "string" || id.length === 0 || byId.has(id)) continue;
      byId.set(id, { title: String(c.title ?? ""), price: String(c.price ?? "") });
    }
  }
  if (byId.size === 0) return "";
  const lines = [...byId.values()].map((c) => `- ${c.title} (${c.price})`);
  return (
    "\n\nAUTHORITATIVE PRODUCTS CITED THIS TURN (ground truth — these are REAL merchant catalog " +
    "items the agent's own citation mechanism resolved, with real Shopify product/variant ids " +
    "behind them; they are NOT invented, so do not flag them as fabricated):\n" +
    lines.join("\n")
  );
}
