import { createInMemoryVectorStore, type VectorPort } from "@palup/platform-ports";
import { PostgresVectorStore } from "./postgres-vector-store.js";
import { pgPoolSqlFromUrl } from "./sql.js";

// Composition root for the vector store (ADR-0001 `vector` port; go-live blocker #1). Mirrors
// createRuntimeStore's env-driven selection EXACTLY: a real Cloud SQL Postgres when DATABASE_URL is set
// (durable + shared across Cloud Run instances), else the in-memory adapter for local/dev/test. Feature
// code only ever sees VectorPort (ADR-0001) — this file is the ONLY place that picks the adapter.
//
// IMPORTANT (the actual bug this closes): without DATABASE_URL each process gets its OWN in-memory
// store, so "durable cross-visit memory" evaporates on restart and is invisible across instances — and,
// critically, a POST /forget erasure (ADR-0015 Invariant 5) would only erase from the ONE instance's
// private memory, leaving any data written to (or later read by) a different instance untouched. That is
// not a real right-to-erasure. Production MUST set DATABASE_URL (same requirement createRuntimeStore
// already imposes for the run-time state store).
export async function createVectorStore(): Promise<{ store: VectorPort; kind: string }> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const store = new PostgresVectorStore(pgPoolSqlFromUrl(url));
    await store.migrate();
    return { store, kind: "postgres" };
  }
  return { store: createInMemoryVectorStore(), kind: "memory" };
}
