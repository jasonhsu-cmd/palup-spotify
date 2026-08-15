import { describe, it, expect } from "vitest";
import { createInMemoryVectorStore, InMemoryRuntimeStore, type ModelPort } from "@palup/platform-ports";
import { createCatalogRetriever } from "../src/catalog-retriever.js";
import { runCatalogIndex, catalogNamespace } from "../src/jobs/catalog-index.js";

function fakeEmbed(): ModelPort {
  return {
    async complete() { throw new Error("unused"); },
    async embed(req) {
      // "serum" texts point along axis 0, others along axis 1 — a query for "serum" ranks serum first.
      return {
        vectors: req.texts.map((t) => (/serum/i.test(t) ? [1, 0, 0] : [0, 1, 0])),
        dimension: 3, model: "gemini-embedding-2", purpose: req.purpose,
      };
    },
  };
}

describe("catalog-retriever returns hits-with-metadata + corpus count", () => {
  it("carries title/variantId metadata and manifest.products", async () => {
    const vector = createInMemoryVectorStore();
    const store = new InMemoryRuntimeStore();
    const catalog = async () => ({
      tenantId: "t1", brandName: "B", policy: { returns: "r", shipping: "s" },
      products: [
        { id: "p1", title: "Glow Serum", description: "d", price: "$40", variantId: "v1", tags: ["serum"] },
        { id: "p2", title: "Cleanser", description: "d", price: "$18" },
      ],
    });
    await runCatalogIndex({ store, vector, model: fakeEmbed(), catalog }, ["t1"]);
    const retriever = createCatalogRetriever({ store, vector, model: fakeEmbed() });
    const { hits, corpusProductCount } = await retriever.retrieve({ tenantId: "t1", query: "serum please", k: 5 });
    expect(corpusProductCount).toBe(2);
    expect(hits[0].productId).toBe("p1");
    expect(hits[0].metadata).toMatchObject({ title: "Glow Serum", variantId: "v1" });
  });
});
