import { describe, it, expect } from "vitest";
import {
  createInMemoryVectorStore,
  InMemoryRuntimeStore,
  type GroundingContext,
  type ModelPort,
} from "@palup/platform-ports";
import { runCatalogIndex, catalogNamespace } from "../src/jobs/catalog-index.js";

/** A fake embedder: deterministic, dimension-3, so no real Vertex is touched. */
function fakeEmbedModel(): ModelPort {
  return {
    async complete() {
      throw new Error("not used");
    },
    async embed(req) {
      return {
        vectors: req.texts.map((_t, i) => [1, i, 0]),
        dimension: 3,
        model: "fake-embed",
        purpose: req.purpose,
      };
    },
  };
}

function catalogOf(products: GroundingContext["products"]): GroundingContext {
  return { tenantId: "t1", brandName: "Brand", products, policy: { returns: "r", shipping: "s" } };
}

describe("catalog-index producer — render metadata", () => {
  it("writes title, variantId and imageUrl into each corpus record's metadata", async () => {
    const vector = createInMemoryVectorStore();
    const store = new InMemoryRuntimeStore();
    const img = "https://cdn.shopify.com/s/files/1/0001/vc.jpg";
    const catalog = async () =>
      catalogOf([
        { id: "p1", title: "Vitamin-C Serum", description: "d", price: "$34", variantId: "111", tags: ["serum"], imageUrl: img },
        { id: "p2", title: "Daily Cleanser", description: "d", price: "$18" }, // no variantId, no image
      ]);

    const [report] = await runCatalogIndex({ store, vector, model: fakeEmbedModel(), catalog }, ["t1"]);
    expect(report.outcome).toBe("indexed");

    const rows = await vector.query(catalogNamespace("t1"), { text: "", k: 10 });
    const byId = new Map(rows.map((r) => [(r.metadata as any).productId, r.metadata as any]));
    // imageUrl is a STABLE render field (like title/variantId), carried so a retrieval-path card shows a thumbnail.
    expect(byId.get("p1")).toMatchObject({ kind: "product", productId: "p1", title: "Vitamin-C Serum", variantId: "111", imageUrl: img });
    expect(byId.get("p1").contentHash).toEqual(expect.any(String));
    // variantId and imageUrl are OMITTED (not undefined-valued) when the source has none.
    expect(byId.get("p2")).toMatchObject({ kind: "product", productId: "p2", title: "Daily Cleanser" });
    expect("variantId" in byId.get("p2")).toBe(false);
    expect("imageUrl" in byId.get("p2")).toBe(false);
  });

  it("prunes a delisted product's row on the next index run (corpus is the authoritative set)", async () => {
    const vector = createInMemoryVectorStore();
    const store = new InMemoryRuntimeStore();
    let products = [
      { id: "p1", title: "Serum", description: "d", price: "$34" },
      { id: "p2", title: "Cleanser", description: "d", price: "$18" },
    ];
    const catalog = async () => catalogOf(products);
    await runCatalogIndex({ store, vector, model: fakeEmbedModel(), catalog }, ["t1"]);
    products = products.filter((p) => p.id !== "p2"); // delist p2
    const [r2] = await runCatalogIndex({ store, vector, model: fakeEmbedModel(), catalog }, ["t1"]);
    expect(r2.removed).toBe(1);
    const rows = await vector.query(catalogNamespace("t1"), { text: "", k: 10 });
    expect(rows.map((x) => (x.metadata as any).productId).sort()).toEqual(["p1"]);
  });
});
