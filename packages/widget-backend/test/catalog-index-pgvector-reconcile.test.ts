import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  InMemoryRuntimeStore,
  requireEmbedInputs,
  type EmbedRequest,
  type EmbedResponse,
  type GroundingContext,
  type ModelPort,
  type Product,
} from "@palup/platform-ports";
import { PgVectorStore, type Sql } from "@palup/state-postgres";
import { startPgvectorContainer, PGVECTOR_AVAILABLE } from "@palup/state-postgres/test/helpers/pgvector-container";
import { runCatalogIndex, catalogNamespace, type CatalogSource } from "../src/jobs/catalog-index.js";
import { readCorpusLedger } from "../src/jobs/catalog-ledger.js";

// HEADLINE (S3 §B/§G): the S2-parked bug, now closed. A >5000-entry ledger reconcile runs on the REAL
// pgvector HNSW store (which THROWS on a text-modality query) with ZERO `query({text:""})` calls and no
// throw. This is why the pgvector merge-gate step now also covers the ANN-safe reconcile.

const DIMENSION = 8;

function fakeModel(): ModelPort {
  return {
    async complete() {
      return { text: "ok", model: "fake-embed-8d" };
    },
    async embed(req: EmbedRequest): Promise<EmbedResponse> {
      requireEmbedInputs(req);
      const vectors = req.texts.map((t) => {
        const v = new Array(DIMENSION).fill(0);
        for (let i = 0; i < t.length; i++) v[i % DIMENSION] += (t.charCodeAt(i) % 5) + 1;
        return v;
      });
      return { vectors, model: "fake-embed-8d", dimension: DIMENSION, purpose: req.purpose };
    },
  };
}

function bigCatalog(n: number, renameFirst = 0): CatalogSource {
  return async (tenantId): Promise<GroundingContext> => {
    const products: Product[] = [];
    for (let i = 0; i < n; i++) {
      products.push({
        id: `gid://shopify/Product/${i}`,
        title: i < renameFirst ? `title-${i}-v2` : `title-${i}`,
        description: `desc-${i}`,
        price: "$10",
        tags: [`tag-${i % 50}`],
        availableForSale: true,
      });
    }
    return { tenantId, brandName: "Big", products, policy: { returns: "", shipping: "" } };
  };
}

describe.skipIf(!PGVECTOR_AVAILABLE)("HEADLINE — >5000-entry ledger reconcile on real pgvector", () => {
  let sql: Sql;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    ({ sql, stop } = await startPgvectorContainer());
    await new PgVectorStore(sql, { dimension: DIMENSION, efSearch: 40 }).migrate();
  }, 120_000);

  afterAll(async () => {
    await stop?.();
  }, 120_000);

  it("indexes 6000 SKUs, then reconciles a delta, with zero text-modality queries and no throw", async () => {
    await sql.query("TRUNCATE vp_ann");
    const store = new InMemoryRuntimeStore();
    const vector = new PgVectorStore(sql, { dimension: DIMENSION, efSearch: 40 });
    const model = fakeModel();
    const querySpy = vi.spyOn(vector, "query");

    const [first] = await runCatalogIndex({ store, vector, model, catalog: bigCatalog(6000) }, ["big"], {});
    expect(first!.outcome).toBe("indexed");
    expect(first!.written).toBe(6000);
    expect((await readCorpusLedger(store, "big")).size).toBe(6000);

    // Reconcile a delta: rename the first 3 products (changed) and drop the last 1000 (stale) -> 5000 left.
    const [second] = await runCatalogIndex(
      { store, vector, model, catalog: bigCatalog(5000, 3) },
      ["big"],
      {},
    );
    expect(second!.outcome).toBe("indexed");
    expect(second!.embedded).toBe(3); // only the 3 renamed
    expect(second!.removed).toBe(1000); // the delisted tail
    expect((await readCorpusLedger(store, "big")).size).toBe(5000);

    // The whole run never issued a text-modality query (which PgVectorStore would have thrown on).
    const textQueries = querySpy.mock.calls.filter(([, q]) => typeof (q as { text?: unknown }).text === "string");
    expect(textQueries).toEqual([]);
  }, 120_000);
});
