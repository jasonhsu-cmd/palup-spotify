import { describe, it, expect, vi } from "vitest";
import {
  InMemoryRuntimeStore,
  createInMemoryVectorStore,
  requireEmbedInputs,
  type EmbedRequest,
  type EmbedResponse,
  type GroundingContext,
  type ModelPort,
  type Product,
} from "@palup/platform-ports";
import { runCatalogIndex, reconcileProducts, catalogRecordId, type CatalogByIdSource, type CatalogSource } from "../src/jobs/catalog-index.js";
import { readCorpusLedger } from "../src/jobs/catalog-ledger.js";
import { productIdOf } from "../src/shopify-webhook-identity.js";

// S3 §C fix round 2 — the REAL webhook→reconcile seam, end to end: a webhook body carrying
// `admin_graphql_api_id` → `productIdOf` → `productIds` → `reconcileProducts`, run against a corpus that
// was indexed with THAT SAME GID as its record id (the way the full-catalog path really builds it — off
// `Product.id`, the Storefront GID). This is the exact defect fix round 1 introduced: `productIdOf` used
// to strip the GID down to its bare numeric tail, which built `product:<bare-number>` — a key that never
// matches the real `product:<GID>` corpus/ledger entry — and would have sent a bare number to
// `nodes(ids:)`, which requires a GID. This test fails against that bare-numeric code (verified this
// session by reverting `productIdOf` and re-running — see task-5-report.md) and passes against the fix.

function fakeModel(dimension = 4, model = "fake-embed-4d"): ModelPort {
  return {
    async complete() {
      return { text: "ok", model };
    },
    async embed(req: EmbedRequest): Promise<EmbedResponse> {
      requireEmbedInputs(req);
      const vectors = req.texts.map((t) => {
        const v = new Array(dimension).fill(0);
        for (let i = 0; i < t.length; i++) v[i % dimension] += t.charCodeAt(i) % 7;
        return v;
      });
      return { vectors, model, dimension, purpose: req.purpose };
    },
  };
}

const REAL_GID = "gid://shopify/Product/555";
const P = (id: string, title: string, price = "$10"): Product => ({ id, title, description: `${title} d`, price, tags: [title], availableForSale: true });
const A = P(REAL_GID, "widget");
const fullCatalog = (ps: Product[]): CatalogSource => async (t): Promise<GroundingContext> => ({ tenantId: t, brandName: "Acme", products: ps, policy: { returns: "", shipping: "" } });

describe("S3 §C fix round 2 — webhook GID -> reconcileProducts touches the REAL corpus key", () => {
  it("a products/update webhook body's admin_graphql_api_id resolves to a productId that matches the corpus record built by the full index", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const model = fakeModel();

    // 1. Index the whole catalog once (the real path: corpus keys are `product:<Storefront-GID>`).
    await runCatalogIndex({ store, vector, model, catalog: fullCatalog([A]) }, ["acme"]);
    const initialLedger = await readCorpusLedger(store, "acme");
    expect([...initialLedger.keys()]).toEqual([catalogRecordId(REAL_GID)]);

    // 2. A REALISTIC Shopify products/update webhook body — the exact shape the route hands to
    // `productIdOf` (routes/shopify-webhooks.ts's `handleCatalogChange`).
    const webhookBody = { id: 555, admin_graphql_api_id: REAL_GID, title: "Widget (updated)" };
    const productId = productIdOf(webhookBody as Record<string, unknown>);
    expect(productId).toBe(REAL_GID); // the id this seam carries end to end

    // 3. reconcileProducts, called with EXACTLY what the real webhook->queue->worker path would pass.
    const Aupdated = P(REAL_GID, "widget-updated", "$15");
    const catalogById: CatalogByIdSource = async () => [Aupdated];
    const upsertSpy = vi.spyOn(vector, "upsert");

    const r = await reconcileProducts({ store, vector, model, catalog: fullCatalog([Aupdated]), catalogById }, "acme", [productId!], { reason: "product" });

    expect(r.outcome).toBe("indexed");
    // THE ASSERTION THAT FAILS UNDER THE BARE-NUMERIC BUG: the upserted record id must be the SAME key the
    // full-catalog index actually wrote (`product:<GID>`), not `product:555` (which the corpus never had).
    const upsertedIds = upsertSpy.mock.calls.flatMap(([, recs]) => recs.map((x) => x.id));
    expect(upsertedIds).toEqual([catalogRecordId(REAL_GID)]);
    expect(r.embedded).toBe(1); // it WAS re-embedded — under the bug, toEmbed is computed against a ledger
    // key (`product:555`) that never existed, so this row silently doesn't match and the real
    // `product:<GID>` row is left stale, unquoted, and never refreshed.

    const ledgerAfter = await readCorpusLedger(store, "acme");
    expect([...ledgerAfter.keys()]).toEqual([catalogRecordId(REAL_GID)]); // still exactly one entry, same key
    expect(ledgerAfter.get(catalogRecordId(REAL_GID))).not.toBe(initialLedger.get(catalogRecordId(REAL_GID))); // hash changed
  });
});
