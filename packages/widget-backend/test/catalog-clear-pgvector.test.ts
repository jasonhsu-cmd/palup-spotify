import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
import { runCatalogIndex, runCatalogClear, type CatalogSource } from "../src/jobs/catalog-index.js";
import { listLedgerChunkKeys } from "../src/jobs/catalog-ledger.js";

// HEADLINE (S4 §F): `runCatalogClear` used to count before/after via a text-modality `vector.query`,
// which THROWS on the S1 pgvector/VECTOR_ANN store. This proves the ledger-based clear runs on a REAL
// pgvector store with ZERO text-modality query and no throw.

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
function catalog(n: number): CatalogSource {
  return async (tenantId): Promise<GroundingContext> => {
    const products: Product[] = [];
    for (let i = 0; i < n; i++)
      products.push({
        id: `gid://shopify/Product/${i}`,
        title: `t-${i}`,
        description: `d-${i}`,
        price: "$1",
        tags: [`x`],
        availableForSale: true,
      });
    return { tenantId, brandName: "B", products, policy: { returns: "", shipping: "" } };
  };
}

describe.skipIf(!PGVECTOR_AVAILABLE)("runCatalogClear — pgvector-safe (no text-modality query)", () => {
  let sql: Sql;
  let stop: () => Promise<void>;
  beforeAll(async () => {
    ({ sql, stop } = await startPgvectorContainer());
    await new PgVectorStore(sql, { dimension: DIMENSION, efSearch: 40 }).migrate();
  }, 120_000);
  afterAll(async () => {
    await stop?.();
  }, 120_000);

  it("clears an indexed corpus on pgvector without throwing, and erases every ledger chunk", async () => {
    await sql.query("TRUNCATE vp_ann");
    const vector = new PgVectorStore(sql, { dimension: DIMENSION, efSearch: 40 });
    const store = new InMemoryRuntimeStore();
    await runCatalogIndex({ store, vector, model: fakeModel(), catalog: catalog(50) }, ["acme"], {});
    expect((await listLedgerChunkKeys(store, "acme")).length).toBeGreaterThan(0);

    const report = await runCatalogClear({ store, vector }, "acme"); // must NOT throw on pgvector
    expect(report.confirmed).toBe(true);
    expect(report.removed).toBe(50);
    expect(await listLedgerChunkKeys(store, "acme")).toEqual([]);
  });
});
