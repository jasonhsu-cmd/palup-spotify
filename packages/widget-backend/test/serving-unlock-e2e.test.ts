import { describe, it, expect } from "vitest";
import {
  createInMemoryVectorStore, InMemoryRuntimeStore, createInMemoryProductFactsStore,
  type GroundingContext, type GroundingPort, type ModelPort, type ProductFactsPort,
} from "@palup/platform-ports";
import { createBrain, DEFAULT_POLICY } from "@palup/widget-brain";
import type { Signals } from "@palup/widget-brain";
import { runCatalogIndex } from "../src/jobs/catalog-index.js";
import { createCatalogRetriever } from "../src/catalog-retriever.js";

const DIM = 1536;
/** Deterministic fake embedder: bucket a text onto one of DIM axes by a cheap keyword hash, so a query
 *  and the docs sharing its keyword land on the same axis and rank highest under cosine.
 *
 *  MODEL ID NOTE (build-verify correction, post-brief): `catalog-index.ts`'s pin check
 *  (`pinMismatch`) and `catalog-retriever.ts`'s query-side check only ever compare the corpus
 *  MANIFEST's recorded `{model, dimension, purpose}` against what THIS SAME embedder reports at
 *  query time — there is no separate assertion anywhere in this path against the real deployment's
 *  `DEFAULT_EMBED_MODEL`/`PALUP_EMBED_MODEL` (that pin lives in `@palup/model-vertex`, which this
 *  fake never touches). So the reported `model` string is cosmetic here as long as index-time and
 *  query-time agree with EACH OTHER — which they do, since both call sites below construct this same
 *  `fakeEmbed()`. Reported as the real GA default (`gemini-embedding-001`, per the S2 manifest pin) for
 *  readability, not because anything enforces it. Only `dimension` (1536) is actually load-bearing. */
function fakeEmbed(): ModelPort {
  const axis = (t: string) => {
    const kw = (t.toLowerCase().match(/serum|cleanser|cream|spf|mask/) ?? ["misc"])[0];
    let h = 0; for (const c of kw) h = (h * 31 + c.charCodeAt(0)) % DIM;
    const v = Array(DIM).fill(0); v[h] = 1; return v;
  };
  return {
    async complete() { throw new Error("embedder has no complete"); },
    async embed(req) { return { vectors: req.texts.map(axis), dimension: DIM, model: "gemini-embedding-001", purpose: req.purpose }; },
  };
}

/** >1000 fake products; getContext THROWS a ceiling (proving it is never called on the render path). */
function bigCatalog(n: number) {
  const cats = ["serum", "cleanser", "cream", "spf", "mask"];
  const products = Array.from({ length: n }, (_, i) => ({
    id: `p${i}`, title: `${cats[i % cats.length]} #${i}`, description: `desc ${i}`,
    price: `$${10 + (i % 40)}`, variantId: `v${i}`, tags: [cats[i % cats.length]],
  }));
  return products;
}

describe("S2 headline E2E — >1000-SKU store renders top-K in /chat", () => {
  it("renders retrieved products (metadata + fresh ProductFacts price) with no full-catalog fetch and no ceiling throw", async () => {
    const vector = createInMemoryVectorStore();
    const store = new InMemoryRuntimeStore();
    const facts = createInMemoryProductFactsStore();
    const products = bigCatalog(1500);

    // 1) INDEX the >1000 corpus (index path, deep, mock embed — no real Vertex).
    const catalog = async (): Promise<GroundingContext> => ({ tenantId: "big", brandName: "MegaSkin", policy: { returns: "30d", shipping: "free" }, products });
    const [report] = await runCatalogIndex({ store, vector, model: fakeEmbed(), catalog }, ["big"]);
    expect(report.outcome).toBe("indexed");
    expect(report.written).toBe(1500);

    // 2) fresh ProductFacts price for a couple of serum SKUs.
    await facts.upsertMany("big", [
      { productId: "p0", price: "$99", availableForSale: true, updatedAt: new Date().toISOString() },
    ]);

    // 3) grounding whose getContext throws (never called), getShell returns brand+policy.
    const grounding: GroundingPort = {
      async getContext() { throw new Error("CEILING: whole-catalog fetch must not happen on the render path"); },
      async getShell(tenantId) { return { tenantId, brandName: "MegaSkin", policy: { returns: "30d", shipping: "free" } }; },
      async getProductsByIds() { return []; },
    };

    // 4) brain, retrieval + hydration ON, real retriever over the in-memory corpus.
    let system = "";
    const model: ModelPort = {
      async complete(req) { system = req.messages.find((m) => m.role === "system")?.content ?? ""; return { text: "Two great serums:", model: "mock" }; },
      async embed() { throw new Error("brain does not embed"); },
    };
    const retriever = createCatalogRetriever({ store, vector, model: fakeEmbed() });
    const brain = createBrain(
      model, grounding, DEFAULT_POLICY, undefined, "shopper-demo",
      undefined, false, false, false, false,
      retriever, true, 12,
      false, false, false, false,
      facts as ProductFactsPort, true,
    );

    const signals: Signals = { tenantId: "big" };
    const decision = await brain.decide(signals, "show me a serum");

    expect(decision.flags).toContain("retrieval:applied");   // retrieval happened
    expect(decision.reply.length).toBeGreaterThan(0);        // a real reply, no ceiling throw
    expect(system).toContain("CATALOG (");                    // a narrowed block, not the whole catalog
    expect(system).toMatch(/serum #\d+/);                     // serum SKUs rendered from corpus metadata
    expect(system).toContain("$99");                          // fresh ProductFacts price overlaid (p0)
    expect(system).toContain("of 1500 products");             // "N of M" from the manifest count
  });

  // Step 5 (S1 pgvector variant) intentionally SKIPPED here — S3-parked. The offline index job's
  // stale-reconcile enumerates the existing corpus via `vector.query(ns, { text: "" })` (a TEXT query),
  // which the S1 pgvector adapter (VECTOR_ANN) rejects — it is vector-only and throws
  // `PgVectorTextQueryUnsupported`. That enumerate/pgvector incompatibility is a known, already-ruled-on
  // gap (see the S2 ledger's Task 4 ruling) and is out of scope for this headline proof; the in-memory
  // variant above (which supports the text enumerate) is the required acceptance evidence.
});
