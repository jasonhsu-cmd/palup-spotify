import { createInMemoryVectorStore, type VectorPort } from "@palup/platform-ports";
import { PostgresVectorStore } from "./postgres-vector-store.js";
import { pgPoolSqlFromUrl, type Sql } from "./sql.js";

// Composition root for the vector store (ADR-0001 `vector` port; ADR-0015 durable cross-visit memory).
// Mirrors createRuntimeStore's env-driven selection: a real Cloud SQL Postgres when DATABASE_URL is set
// (durable + shared across Cloud Run instances), else the in-memory adapter for local/dev/test, AND the
// SAME PALUP_REQUIRE_DATABASE_URL fail-fast (see below). Feature code only ever sees VectorPort
// (ADR-0001) — this file is the ONLY place that picks the adapter.
//
// IMPORTANT (the actual bug this closes): without DATABASE_URL each process gets its OWN in-memory
// store, so "durable cross-visit memory" evaporates on restart and is invisible across instances — and,
// critically, a POST /forget erasure (ADR-0015 Invariant 5) would only erase from the ONE instance's
// private memory, leaving any data written to (or later read by) a different instance untouched. That is
// not a real right-to-erasure. Production MUST set DATABASE_URL (same requirement createRuntimeStore
// already imposes for the run-time state store).
//
// SHARED POOL (security review, HIGH — "doubles the per-process Postgres connection pool"): the caller
// (widget-backend/server.ts) constructs the run-time state store FIRST and can pass its own `Sql` in
// here via the optional `sql` param, so exactly ONE `pg.Pool` exists per process even though BOTH the
// run-time state store and the vector store are backed by the same Cloud SQL instance. Only when no
// shared `sql` is supplied (e.g. a caller — like control-plane — that never constructs a runtime store at
// all) does this function fall back to building its own pool from DATABASE_URL.
export async function createVectorStore(sql?: Sql): Promise<{ store: VectorPort; kind: string }> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const store = new PostgresVectorStore(sql ?? pgPoolSqlFromUrl(url));
    await store.migrate();
    return { store, kind: "postgres" };
  }
  // FAIL FAST when a durable store is REQUIRED (mirrors createRuntimeStore's OWN identical guard EXACTLY
  // — security review, MEDIUM: this branch was previously missing here, so a prod misconfig would
  // silently degrade to a per-process in-memory store; /forget would then return {ok:true} and write an
  // `erase.subject` audit record for an erasure that never durably happened — a false right-to-erasure
  // confirmation). Never boot prod without DATABASE_URL.
  if (process.env.PALUP_REQUIRE_DATABASE_URL === "true") {
    throw new Error(
      "PALUP_REQUIRE_DATABASE_URL=true but DATABASE_URL is unset — refusing to boot with a non-durable, " +
        "per-process vector store. Set DATABASE_URL to the shared Cloud SQL instance (a POST /forget " +
        "erasure must be REAL, not a per-process no-op — ADR-0015 Inv 5).",
    );
  }
  return { store: createInMemoryVectorStore(), kind: "memory" };
}
