import { describe, it, expect, vi } from "vitest";
import {
  InMemoryRuntimeStore,
  createInMemoryVectorStore,
  createInMemoryProductFactsStore,
  requireEmbedInputs,
  type EmbedRequest,
  type EmbedResponse,
  type GroundingContext,
  type ModelPort,
  type Product,
} from "@palup/platform-ports";
import {
  runCatalogIndex,
  reconcileProducts,
  catalogNamespace,
  catalogRecordId,
  type CatalogSource,
  type CatalogByIdSource,
} from "../src/jobs/catalog-index.js";
import { readCorpusLedger } from "../src/jobs/catalog-ledger.js";

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
const P = (id: string, title: string, price = "$10"): Product => ({ id, title, description: `${title} d`, price, tags: [title], availableForSale: true });
const A = P("gid://shopify/Product/1", "alpha");
const B = P("gid://shopify/Product/2", "beta");
const C = P("gid://shopify/Product/3", "gamma");
const fullCatalog = (ps: Product[]): CatalogSource => async (t): Promise<GroundingContext> => ({ tenantId: t, brandName: "Acme", products: ps, policy: { returns: "", shipping: "" } });

describe("S3 §C — reconcileProducts touches ONLY the changed set", () => {
  it("upserts only the named product and leaves every other row untouched", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const model = fakeModel();
    await runCatalogIndex({ store, vector, model, catalog: fullCatalog([A, B, C]) }, ["acme"]);
    const before = await readCorpusLedger(store, "acme");

    const upsertSpy = vi.spyOn(vector, "upsert");
    const Bx = P("gid://shopify/Product/2", "beta-updated", "$12");
    const catalogById: CatalogByIdSource = async () => [Bx];
    const facts = createInMemoryProductFactsStore();

    const r = await reconcileProducts({ store, vector, model, catalog: fullCatalog([A, Bx, C]), catalogById, productFacts: facts }, "acme", [B.id], {
      reason: "product",
    });

    expect(r.outcome).toBe("indexed");
    expect(r.embedded).toBe(1);
    const upsertedIds = upsertSpy.mock.calls.flatMap(([, recs]) => recs.map((x) => x.id));
    expect(upsertedIds).toEqual([catalogRecordId(B.id)]);
    // Ledger still has all three entries; B's hash actually CHANGED, A's and C's did NOT (untouched by a
    // reconcile that only named B).
    const after = await readCorpusLedger(store, "acme");
    expect(after.size).toBe(3);
    expect(after.get(catalogRecordId(B.id))).not.toBe(before.get(catalogRecordId(B.id)));
    expect(after.get(catalogRecordId(A.id))).toBe(before.get(catalogRecordId(A.id)));
    expect(after.get(catalogRecordId(C.id))).toBe(before.get(catalogRecordId(C.id)));
    // ProductFacts refreshed for B only.
    expect((await facts.getMany("acme", [B.id]))[0]!.price).toBe("$12");
    expect(await facts.getMany("acme", [A.id])).toEqual([]);
  });

  it("a delisted id (not returned by fetch) is deleteById'd and dropped from the ledger, no whole-catalog crawl", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const model = fakeModel();
    await runCatalogIndex({ store, vector, model, catalog: fullCatalog([A, B, C]) }, ["acme"]);

    const deleteSpy = vi.spyOn(vector, "deleteById");
    const catalogById: CatalogByIdSource = async () => []; // C resolved to nothing => delisted
    const catalogSpy = vi.fn(fullCatalog([A, B]));

    const r = await reconcileProducts({ store, vector, model, catalog: catalogSpy, catalogById }, "acme", [C.id], { reason: "product" });

    expect(r.outcome).toBe("indexed");
    expect(r.removed).toBe(1);
    expect(deleteSpy.mock.calls.flatMap((c) => c[1])).toEqual([catalogRecordId(C.id)]);
    expect(catalogSpy).not.toHaveBeenCalled(); // NEVER fell back to a full crawl
    const ledger = await readCorpusLedger(store, "acme");
    expect([...ledger.keys()].sort()).toEqual([catalogRecordId(A.id), catalogRecordId(B.id)]);
  });

  it("BUGFIX (stale product_facts) — a delisted product's money-facts row is pruned, not just its vector", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const model = fakeModel();
    const facts = createInMemoryProductFactsStore();
    // Seed a 3-product corpus AND its Tier-2 money-facts (the poll producer writes facts on every index).
    await runCatalogIndex({ store, vector, model, catalog: fullCatalog([A, B, C]), productFacts: facts }, ["acme"]);
    expect((await facts.getMany("acme", [C.id])).map((x) => x.productId)).toEqual([C.id]); // sanity: C's fact exists

    // C is deleted in Shopify → the targeted reconcile resolves it to nothing (delisted).
    const catalogById: CatalogByIdSource = async () => [];
    const r = await reconcileProducts({ store, vector, model, catalog: fullCatalog([A, B]), catalogById, productFacts: facts }, "acme", [C.id], {
      reason: "product",
    });

    expect(r.outcome).toBe("indexed");
    expect(r.removed).toBe(1);
    // The FIX: the delisted product's money-fact is gone (previously it lingered forever — a stale price for
    // a product no longer sold).
    expect(await facts.getMany("acme", [C.id])).toEqual([]);
    // Survivors untouched.
    expect((await facts.getMany("acme", [A.id, B.id])).map((x) => x.productId).sort()).toEqual([A.id, B.id]);
  });

  it("BUGFIX (stale product_facts, full path) — a product removed from the catalog has its money-facts row pruned", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const model = fakeModel();
    const facts = createInMemoryProductFactsStore();
    await runCatalogIndex({ store, vector, model, catalog: fullCatalog([A, B, C]), productFacts: facts }, ["acme"]);
    expect((await facts.getMany("acme", [C.id])).map((x) => x.productId)).toEqual([C.id]);

    // Next full index sees C gone (bulk-deleted). The whole-catalog reconcile must prune its money-fact too.
    const [r] = await runCatalogIndex({ store, vector, model, catalog: fullCatalog([A, B]), productFacts: facts }, ["acme"]);
    expect(r!.outcome).toBe("indexed");
    expect(r!.removed).toBe(1);
    expect(await facts.getMany("acme", [C.id])).toEqual([]);
    expect((await facts.getMany("acme", [A.id, B.id])).map((x) => x.productId).sort()).toEqual([A.id, B.id]);
  });

  it("with no manifest yet, falls back to a full reconcile (never a 1-product corpus)", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const model = fakeModel();
    const catalogById = vi.fn(async () => [B]);
    const r = await reconcileProducts({ store, vector, model, catalog: fullCatalog([A, B, C]), catalogById }, "acme", [B.id], { reason: "product" });
    expect(r.outcome).toBe("indexed");
    expect(r.products).toBe(3); // the whole catalog, not just B
    expect(catalogById).not.toHaveBeenCalled();
  });

  it("FIX 2 (final review) — a targeted reconcile that would push the corpus past the ceiling refuses, and upserts nothing", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const model = fakeModel();
    // Build a 2-product corpus at a ceiling of 2 (manifest.ceiling === 2, S3's `newLedger`-arithmetic mirror).
    await runCatalogIndex({ store, vector, model, catalog: fullCatalog([A, B]) }, ["acme"], { maxProducts: 2 });

    const upsertSpy = vi.spyOn(vector, "upsert");
    // A products/create webhook for a brand-new SKU — the targeted path's `catalogById` returns it.
    const catalogById: CatalogByIdSource = async () => [C];
    const r = await reconcileProducts({ store, vector, model, catalog: fullCatalog([A, B]), catalogById }, "acme", [C.id], { reason: "product" });

    expect(r.outcome).toBe("ceiling-exceeded");
    expect(upsertSpy).not.toHaveBeenCalled();
    const ledger = await readCorpusLedger(store, "acme");
    expect(ledger.size).toBe(2); // unchanged — C was never written
    expect(ledger.has(catalogRecordId(C.id))).toBe(false);
  });

  it("FIX 3 (security C2, final review) — drops a malformed product id at the reconcile boundary; a well-formed id in the same batch still processes", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const model = fakeModel();
    await runCatalogIndex({ store, vector, model, catalog: fullCatalog([A, B, C]) }, ["acme"]);

    const upsertSpy = vi.spyOn(vector, "upsert");
    const Bx = P(B.id, "beta-updated", "$12");
    const catalogById = vi.fn(async (_t: string, ids: string[]) => {
      // The malformed id must never reach the by-id source — only the well-formed GID is asked for.
      expect(ids).toEqual([B.id]);
      return [Bx];
    });
    const malformed = "not-a-gid; drop table products;--";

    const r = await reconcileProducts(
      { store, vector, model, catalog: fullCatalog([A, Bx, C]), catalogById },
      "acme",
      [malformed, B.id],
      { reason: "product" },
    );

    expect(r.outcome).toBe("indexed");
    const upsertedIds = upsertSpy.mock.calls.flatMap(([, recs]) => recs.map((x) => x.id));
    expect(upsertedIds).toEqual([catalogRecordId(B.id)]);
    // The malformed id built no record key — the ledger names only real products.
    const ledger = await readCorpusLedger(store, "acme");
    expect(ledger.has(catalogRecordId(malformed))).toBe(false);
  });

  it("FIX 3 (security C2, final review) — a batch of ONLY malformed ids falls back to the safe whole-catalog reconcile", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const model = fakeModel();
    await runCatalogIndex({ store, vector, model, catalog: fullCatalog([A, B, C]) }, ["acme"]);
    const catalogById = vi.fn(async () => [B]);

    const r = await reconcileProducts(
      { store, vector, model, catalog: fullCatalog([A, B, C]), catalogById },
      "acme",
      ["not-a-gid", "also-not-a-gid"],
      { reason: "product" },
    );

    // The fallback runs the SAFE whole-catalog path; nothing actually changed since the initial index, so
    // it reports "unchanged" rather than "indexed" — the point is that it fell back at all, not the outcome.
    expect(r.outcome).toBe("unchanged");
    expect(r.products).toBe(3); // the whole catalog — never a partial reconcile off garbage ids
    expect(catalogById).not.toHaveBeenCalled();
  });
});

describe("Pillar 1b — onProducerOk records a live producer run on the TARGETED reconcile path (channel-health)", () => {
  it("is called with the tenantId after a SUCCESSFUL facts upsert", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const model = fakeModel();
    await runCatalogIndex({ store, vector, model, catalog: fullCatalog([A, B, C]) }, ["acme"]);

    const Bx = P("gid://shopify/Product/2", "beta-updated", "$12");
    const catalogById: CatalogByIdSource = async () => [Bx];
    const facts = createInMemoryProductFactsStore();
    const calls: string[] = [];

    const r = await reconcileProducts(
      { store, vector, model, catalog: fullCatalog([A, Bx, C]), catalogById, productFacts: facts, onProducerOk: (t) => { calls.push(t); } },
      "acme",
      [B.id],
      { reason: "product" },
    );

    expect(r.outcome).toBe("indexed");
    expect(calls).toEqual(["acme"]);
  });

  it("is NOT called when productFacts is absent (no money-fact write ⇒ no health signal)", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const model = fakeModel();
    await runCatalogIndex({ store, vector, model, catalog: fullCatalog([A, B, C]) }, ["acme"]);

    const Bx = P("gid://shopify/Product/2", "beta-updated", "$12");
    const catalogById: CatalogByIdSource = async () => [Bx];
    const calls: string[] = [];

    const r = await reconcileProducts(
      { store, vector, model, catalog: fullCatalog([A, Bx, C]), catalogById, onProducerOk: (t) => { calls.push(t); } },
      "acme",
      [B.id],
      { reason: "product" },
    );

    expect(r.outcome).toBe("indexed");
    expect(calls).toEqual([]);
  });
});
