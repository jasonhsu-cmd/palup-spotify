import { InMemoryRuntimeStore, createInMemoryVectorStore } from "@palup/platform-ports";
import type { ModelPort, RuntimeStatePort, VectorPort, GroundingContext } from "@palup/platform-ports";
import type { RetrievedProduct } from "@palup/widget-brain";
import { runCatalogIndex, type CatalogSource } from "./jobs/catalog-index.js";
import { createCatalogRetriever } from "./catalog-retriever.js";

// CATALOG_RETRIEVAL (E1) eval harness — the retrieval-QUALITY layer that catalog-retrieval.test.ts defers to
// "the eval gate's job, on real embeddings". It indexes a catalog through the REAL index path
// (runCatalogIndex → embed purpose:document → vector store + manifest) and retrieves through the REAL
// retriever (createCatalogRetriever → embed purpose:query → vector top-k), so it measures the actual
// serving-path ranking, not a fake. Graded deterministically (recall@k / no-wrong-product).

export interface RetrievalProduct {
  id: string;
  title: string;
  price: string;
  description?: string;
  tags?: string[];
}

export interface RetrievalCase {
  id: string;
  query: string;
  /** Optional per-case k; defaults to the corpus `_meta.k`. */
  k?: number;
  /** The top-ranked id MUST equal this (recall@1 for an unambiguous query). */
  expectTop?: string;
  /** At least one of these ids must appear in the top-k (recall@k). */
  relevantInTopK?: string[];
  /** None of these clearly-irrelevant ids may appear in the top-k (no-wrong-product). */
  notInTopK?: string[];
}

/** Index `products` for `tenantId` through the real path, then return a retriever over the same corpus.
 *  `store`/`vector` default to fresh in-memory adapters; `model` must be embed-capable (Vertex, or a fake
 *  embed model in the structural test). Throws if indexing did not succeed. */
export async function buildIndexedRetriever(
  products: RetrievalProduct[],
  model: ModelPort,
  tenantId = "eval-retrieval",
  store: RuntimeStatePort = new InMemoryRuntimeStore(),
  vector: VectorPort = createInMemoryVectorStore(),
) {
  const ctx: GroundingContext = {
    tenantId,
    brandName: "Test Store",
    products: products.map((p) => ({ description: "", ...p })),
    policy: { returns: "30 days", shipping: "free over $75" },
  };
  const catalog: CatalogSource = async (t) => (t === tenantId ? ctx : undefined);
  const reports = await runCatalogIndex({ store, vector, model, catalog }, [tenantId], {});
  const report = reports[0];
  if (!report || (report.outcome !== "indexed" && report.outcome !== "unchanged")) {
    throw new Error(`retrieval eval: indexing did not succeed — ${JSON.stringify(report)}`);
  }
  return { retriever: createCatalogRetriever({ store, vector, model }), tenantId };
}

/**
 * S4 §D — a scale-representative synthetic corpus for the promotion eval/shadow run. `n` products with
 * unique ids and enough token variety that a top-k retriever has real work to do. Used by the operator
 * runbook (pnpm eval:retrieval at the tenant's scale) and by the pgvector wiring test. A real tenant
 * catalog can be used instead — this is the deterministic default.
 */
export function generateScaleCorpus(n: number): RetrievalProduct[] {
  const out: RetrievalProduct[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `gen-${i}`,
      title: `Product ${i}`,
      price: `$${(i % 100) + 1}`,
      description: `synthetic product ${i} in category ${i % 20} with feature ${i % 7}`,
      tags: [`cat-${i % 20}`, `feat-${i % 7}`],
    });
  }
  return out;
}

/** Deterministic grade of one query's retrieved top-k against the case's expectations. */
export function gradeRetrieval(c: RetrievalCase, hits: RetrievedProduct[]): { pass: boolean; fails: string[] } {
  const ids = hits.map((h) => h.productId);
  const fails: string[] = [];
  if (c.expectTop && ids[0] !== c.expectTop) {
    fails.push(`expected top=${c.expectTop}, got ${ids[0] ?? "(none)"} (top-k: [${ids.join(", ")}])`);
  }
  if (c.relevantInTopK && !c.relevantInTopK.some((id) => ids.includes(id))) {
    fails.push(`no relevant product (${c.relevantInTopK.join("/")}) in top-${ids.length}: [${ids.join(", ")}]`);
  }
  for (const id of c.notInTopK ?? []) {
    if (ids.includes(id)) fails.push(`clearly-irrelevant product ${id} appeared in top-k: [${ids.join(", ")}]`);
  }
  return { pass: fails.length === 0, fails };
}
