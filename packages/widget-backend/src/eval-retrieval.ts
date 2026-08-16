// CATALOG_RETRIEVAL (E1) — the retrieval-QUALITY eval runner. Indexes the corpus and runs each query
// through the REAL retriever on REAL Vertex embeddings, grading recall@k / no-wrong-product deterministically.
// This is the eval gate CATALOG_RETRIEVAL must pass before any live stage (eval → shadow → canary → human,
// HITL §5) — the promotion prerequisite for the whole hydration chain (docs/ADR-0020-PROMOTION-PLAN.md).
// Requires Vertex creds + an embed-capable adapter.
//   pnpm eval:retrieval
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createVertexAdapter, isVertexConfigured } from "@palup/model-vertex";
import { canEmbed } from "@palup/platform-ports";
import { buildIndexedRetriever, gradeRetrieval, type RetrievalCase, type RetrievalProduct } from "./retrieval-eval.js";

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  if (!isVertexConfigured()) {
    console.error("Set GOOGLE_CLOUD_PROJECT + ADC — retrieval runs the real embedder + retriever.");
    process.exit(2);
  }
  const { products, cases, _meta } = JSON.parse(readFileSync(join(here, "..", "cases", "retrieval.json"), "utf8")) as {
    products: RetrievalProduct[];
    cases: RetrievalCase[];
    _meta?: { k?: number };
  };
  const defaultK = _meta?.k ?? 3;
  const model = createVertexAdapter();
  if (!canEmbed(model)) {
    console.error("This deployment's Vertex adapter cannot embed — retrieval cannot be evaluated.");
    process.exit(2);
  }
  const { retriever, tenantId } = await buildIndexedRetriever(products, model);
  const rows: { id: string; pass: boolean; fails: string[] }[] = [];
  for (const c of cases) {
    try {
      const { hits } = await retriever.retrieve({ tenantId, query: c.query, k: c.k ?? defaultK });
      const g = gradeRetrieval(c, hits);
      rows.push({ id: c.id, ...g });
      process.stdout.write(`${g.pass ? "✅" : "❌"} ${c.id} `);
    } catch (e) {
      rows.push({ id: c.id, pass: false, fails: [`error: ${(e as Error).message}`] });
      process.stdout.write(`⚠️ ${c.id} `);
    }
  }
  const fails = rows.filter((r) => !r.pass);
  console.log(`\n\nRETRIEVAL: ${rows.length - fails.length}/${rows.length} passed (k=${defaultK} over ${products.length} products)`);
  for (const r of fails) console.log(`  ❌ ${r.id}: ${r.fails.join("; ")}`);
  if (fails.length > 0) {
    console.error(`\nRETRIEVAL GATE FAIL — ${fails.length} case(s). A wrong/absent top-k degrades what the agent is grounded on.`);
    process.exit(1);
  }
  console.log("RETRIEVAL GATE OK.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
