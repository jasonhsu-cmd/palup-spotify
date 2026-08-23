import { describe, expect, it } from "vitest";
import type { GroundingContext, GroundingPort, ModelPort, ProductFact, ProductFactsPort } from "@palup/platform-ports";
import { DEFAULT_CATALOG_RETRIEVAL_K, MockCommerceAdapter, createBrain } from "../src/index.js";
import type { CatalogRetrieverPort, RetrievedProduct, Signals } from "../src/types.js";
import { RecordingModelPort } from "./helpers/flag-off-probes.js";

// Task 8b (durable-catalog-sync, spec §4.1) — the retrieval RENDER path (`brain.retrieveViaShell`) now
// also reads DESCRIPTIVE fields (description, tags) off a hit's `metadata`, alongside the pre-existing
// title/variantId/imageUrl. Those fields are put there by the RETRIEVER seam (catalog-retriever.ts's
// `localHydration` dep, tested in widget-backend/test/catalog-retriever-local-hydration.test.ts) for a
// BACKFILLED tenant only; this file exercises the brain side of the contract directly against a fake
// retriever that already returns the (hydrated, or not) metadata shape a real one would.
//
// MONEY SURFACE (NN#1): these tests also pin that price/availability are NEVER read off `metadata` — they
// remain exclusively the A1b `ProductFactsPort` overlay's job (hydrate-facts.ts), unaffected by this task.

function bigCatalog(n = DEFAULT_CATALOG_RETRIEVAL_K + 8): GroundingContext {
  return {
    tenantId: "acme",
    brandName: "Acme",
    products: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, title: `Product ${i}`, price: `$${i}`, description: `d${i}` })),
    policy: { returns: "30 days", shipping: "free over $75" },
  };
}

const groundingOf = (ctx: GroundingContext): GroundingPort => ({
  async getContext() {
    return JSON.parse(JSON.stringify(ctx)) as GroundingContext;
  },
  async getShell() {
    return { tenantId: ctx.tenantId, brandName: ctx.brandName, policy: ctx.policy };
  },
  async getProductsByIds(_tenantId, ids) {
    return ctx.products.filter((p) => ids.includes(p.id));
  },
});

function fakeRetriever(hits: RetrievedProduct[]): CatalogRetrieverPort {
  return {
    async retrieve() {
      return { hits, corpusProductCount: hits.length };
    },
  };
}

function brainFor(
  model: ModelPort,
  grounding: GroundingPort,
  retriever: CatalogRetrieverPort,
  opts: { facts?: ProductFactsPort; factsEnabled?: boolean } = {},
) {
  return createBrain(
    model, grounding, undefined, new MockCommerceAdapter(), undefined, undefined,
    false, false, false, false,
    retriever, /* catalogRetrievalEnabled */ true, DEFAULT_CATALOG_RETRIEVAL_K,
    false, false, false, false,
    opts.facts, opts.factsEnabled ?? false,
  );
}

function lastSystemPrompt(model: RecordingModelPort): string {
  const sys = model.requests.at(-1)?.messages.find((m) => m.role === "system");
  if (!sys) throw new Error("no system message");
  return sys.content;
}

function fakeFacts(facts: ProductFact[]): ProductFactsPort {
  return {
    async getMany(_tenantId, ids) {
      return facts.filter((f) => ids.includes(f.productId));
    },
    async upsertMany() {},
    async deleteMany() {},
    async deleteTenant() {},
  };
}

const SALES: Signals = { tenantId: "acme" };
const ASK = "what do you recommend for dull skin?";

describe("Task 8b — retrieval render surfaces locally-hydrated DESCRIPTIVE fields (backfilled tenant)", () => {
  it("AC1: a hit's hydrated description + tags reach the rendered CATALOG block", async () => {
    const model = new RecordingModelPort();
    const hit: RetrievedProduct = {
      productId: "p1",
      score: 0.9,
      metadata: {
        title: "Glow Serum",
        // Task 8b hydration — these come from catalog_product via the retriever seam, never from the
        // vector corpus itself (which carries only title/variantId/imageUrl, S2).
        description: "A vitamin C serum with hyaluronic acid, for dull and uneven skin tone.",
        tags: ["vitamin-c", "hydrating"],
      },
    };
    const d = await brainFor(model, groundingOf(bigCatalog()), fakeRetriever([hit])).decide(SALES, ASK);
    const prompt = lastSystemPrompt(model);
    expect(prompt).toContain("A vitamin C serum with hyaluronic acid");
    expect(prompt).toContain("vitamin-c");
    expect(d.flags).toContain("retrieval:applied");
  });

  it("AC2: fallback — a hit with only the pre-Task-8b metadata shape renders EXACTLY as before (empty description, no tags line)", async () => {
    const model = new RecordingModelPort();
    const hit: RetrievedProduct = { productId: "p1", score: 0.9, metadata: { title: "Glow Serum", variantId: "v1" } };
    await brainFor(model, groundingOf(bigCatalog()), fakeRetriever([hit])).decide(SALES, ASK);
    const prompt = lastSystemPrompt(model);
    expect(prompt).toContain("Glow Serum");
    expect(prompt).not.toMatch(/vitamin C|hyaluronic/);
    expect(prompt).not.toMatch(/\[.*\]/); // no bracketed tags block for this line
  });

  it("AC3 (NN#1, money surface unchanged): a `price` key riding in metadata is never quoted from it", async () => {
    const model = new RecordingModelPort();
    const hit: RetrievedProduct = {
      productId: "p1",
      score: 0.9,
      // A price key here must be inert: the retriever seam never merges price/availability into metadata
      // (see catalog-retriever.ts's localHydration seam) — this pins the brain side of that invariant too,
      // so even an upstream mistake could not leak a price this way.
      metadata: { title: "Glow Serum", description: "rich body wash", price: "$1 (untrusted)" },
    };
    await brainFor(model, groundingOf(bigCatalog()), fakeRetriever([hit])).decide(SALES, ASK);
    const prompt = lastSystemPrompt(model);
    expect(prompt).not.toContain("$1 (untrusted)");
  });

  it("AC3: with A1b product_facts hydration ON, price/availability still come EXCLUSIVELY from ProductFactsPort alongside locally-hydrated description", async () => {
    const model = new RecordingModelPort();
    const hit: RetrievedProduct = {
      productId: "p1",
      score: 0.9,
      metadata: { title: "Glow Serum", description: "a vitamin C serum", tags: ["vitamin-c"] },
    };
    const facts = fakeFacts([{ productId: "p1", price: "$42", availableForSale: true, updatedAt: new Date().toISOString() }]);
    await brainFor(model, groundingOf(bigCatalog()), fakeRetriever([hit]), { facts, factsEnabled: true }).decide(SALES, ASK);
    const prompt = lastSystemPrompt(model);
    expect(prompt).toContain("$42"); // price came from product_facts, the only money channel
    expect(prompt).toContain("a vitamin C serum"); // description came from the local hydration seam
    expect(prompt).toContain("Availability: available to buy now.");
  });

  it("AC3: with A1b hydration ON but NO fact for this id, price stays unconfirmed ('') exactly as before — hydration never invents one from metadata", async () => {
    const model = new RecordingModelPort();
    const hit: RetrievedProduct = {
      productId: "p1",
      score: 0.9,
      metadata: { title: "Glow Serum", description: "a vitamin C serum" },
    };
    await brainFor(model, groundingOf(bigCatalog()), fakeRetriever([hit]), { facts: fakeFacts([]), factsEnabled: true }).decide(SALES, ASK);
    const prompt = lastSystemPrompt(model);
    expect(prompt).toContain("a vitamin C serum");
    expect(prompt).toMatch(/Glow Serum \(\$?\)/); // empty price, same shape as pre-8b
  });
});
