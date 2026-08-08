import { createBrain, DEFAULT_CATALOG_RETRIEVAL_K, DEFAULT_POLICY, MockCommerceAdapter, type Brain } from "@palup/widget-brain";
import { createInMemoryProductFactsStore } from "@palup/platform-ports";
import type { GroundingContext, GroundingPort, ModelPort } from "@palup/platform-ports";

// go-live §B — the MONEY-FACTS eval harness. It exercises the A1b fresh-price serving path END TO END:
// build a brain with retrieval + hydration on, seed the Tier-2 fact store, run the shopper's price
// question, and grade the reply DETERMINISTICALLY. Money facts are graded by exact string checks, not a
// stochastic judge, because "did the reply quote $29" and "did it withhold a stale number" are precisely
// the properties a judge is worst at and a code check is best at (the same reason the safety floor is
// code-graded). The staleness ceiling here is the same 1h default the server ships (PRODUCT_FACTS_MAX_AGE_MS).

export const MONEY_FACTS_MAX_AGE_MS = 3_600_000;

export interface MoneyFactsCase {
  id: string;
  kind: "fresh" | "stale" | "missing" | "cross_tenant";
  tenantId: string;
  /** The catalog the shopper's tenant sees (the base/catalog price is `price`). */
  products: { id: string; title: string; price: string; description?: string; availableForSale?: boolean }[];
  /** Tier-2 facts to seed. `ageMinutes` past the 1h ceiling ⇒ stale. `tenantId` overrides the seed tenant
   *  (a cross_tenant case seeds under a DIFFERENT tenant so the shopper's tenant must never see it). */
  facts: { productId: string; price: string; ageMinutes: number; availableForSale?: boolean; tenantId?: string }[];
  message: string;
  expect: { quotes?: string; notQuotes?: string[]; withholdsPrice?: boolean; confirms?: boolean };
}

// Retrieval only narrows when the catalog is LARGER than k (retrieveCandidates returns undefined
// otherwise), and hydration only applies to the retrieved subset — so a case with 1-2 products would never
// hydrate. Pad with filler above k; the retriever then returns ONLY the case's real product ids.
function paddedProducts(spec: MoneyFactsCase): GroundingContext["products"] {
  const filler = Array.from({ length: DEFAULT_CATALOG_RETRIEVAL_K + 2 }, (_, i) => ({
    id: `__filler_${i}`,
    title: `Filler product ${i}`,
    price: `$${100 + i}`,
    description: "An unrelated filler product.",
  }));
  return [...spec.products.map((p) => ({ description: "", ...p })), ...filler];
}

/** Build the hydration-enabled brain for one money-facts case, with the fact store seeded.
 *
 * WALL-CLOCK COUPLING (why there is no injected `now`). The brain measures a fact's age against its OWN
 * `new Date()` at decide() time (brain.ts, the D2 staleness ceiling) — that clock is NOT injectable. So a
 * fact's `updatedAt` MUST be seeded relative to the SAME real clock, or `ageMinutes` would be measured
 * against the wrong origin (a fixed future instant makes a "3-hours-old" fact read as negative-age/fresh).
 * We therefore stamp `updatedAt` from `Date.now()` here; the sub-second gap until the brain reads its clock
 * is immaterial because every case's `ageMinutes` sits far from the 60-minute ceiling. */
export async function buildMoneyFactsBrain(spec: MoneyFactsCase, model: ModelPort): Promise<Brain> {
  const seededNow = Date.now();
  const products = paddedProducts(spec);
  const grounding: GroundingPort = {
    async getContext(tenantId) {
      return { tenantId, brandName: "Test Store", products, policy: { returns: "30 days", shipping: "free over $75" } };
    },
  };
  // Nearest-first on the case's REAL ids only, so hydration applies exactly to them.
  const retriever = { async retrieve() { return spec.products.map((p, i) => ({ productId: p.id, score: 1 - i / 100 })); } };

  const facts = createInMemoryProductFactsStore();
  for (const f of spec.facts) {
    await facts.upsertMany(f.tenantId ?? spec.tenantId, [
      {
        productId: f.productId,
        price: f.price,
        ...(f.availableForSale !== undefined ? { availableForSale: f.availableForSale } : {}),
        updatedAt: new Date(seededNow - f.ageMinutes * 60_000).toISOString(),
      },
    ]);
  }

  return createBrain(
    model, grounding, DEFAULT_POLICY, new MockCommerceAdapter(), "shopper-demo", undefined,
    false, false, false, false,
    retriever, /* catalogRetrieval */ true, DEFAULT_CATALOG_RETRIEVAL_K,
    false, false, false, false,
    facts, /* hydration */ true,
    undefined, false,
    MONEY_FACTS_MAX_AGE_MS,
  );
}

const PRICE_TOKEN = /\$\s?\d|\b\d+\s*(usd|dollars?)\b/i;

/** Deterministic grade of a (stochastic) reply against the case's expectations. */
export function gradeMoneyFacts(spec: MoneyFactsCase, reply: string): { pass: boolean; fails: string[] } {
  const fails: string[] = [];
  if (spec.expect.quotes && !reply.includes(spec.expect.quotes)) fails.push(`did not quote the current price ${spec.expect.quotes}`);
  for (const n of spec.expect.notQuotes ?? []) if (reply.includes(n)) fails.push(`quoted a price it must not (${n})`);
  if (spec.expect.withholdsPrice && PRICE_TOKEN.test(reply)) fails.push("stated a price number when the price was unconfirmed (should withhold)");
  if (spec.expect.confirms && !(/\b(confirm|verify|double.?check|check)\b/i.test(reply) && /\bprice\b/i.test(reply))) {
    fails.push("did not offer to confirm the current price");
  }
  return { pass: fails.length === 0, fails };
}
