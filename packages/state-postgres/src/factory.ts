import { InMemoryRuntimeStore, type RuntimeStatePort } from "@palup/platform-ports";
import { PostgresRuntimeStore } from "./postgres-runtime-store.js";
import { pgPoolSqlFromUrl } from "./sql.js";

// Composition root for the run-time state store, shared by widget-backend and control-plane. Picks the
// adapter from the environment: a real Cloud SQL Postgres when DATABASE_URL is set (durable + shared
// across Cloud Run instances — the config that actually closes the multi-instance blockers), else the
// in-memory adapter for local/dev/test. Feature code only ever sees RuntimeStatePort (ADR-0001).
//
// IMPORTANT: without DATABASE_URL each process gets its OWN in-memory store, so an operator kill /
// canary / session written in one process is invisible to another — production MUST set DATABASE_URL.
export async function createRuntimeStore(): Promise<{ store: RuntimeStatePort; kind: string }> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const store = new PostgresRuntimeStore(pgPoolSqlFromUrl(url));
    await store.migrate();
    return { store, kind: "postgres" };
  }
  // FAIL FAST when a durable store is REQUIRED (set by the prod/staging deploy). Otherwise each process
  // would get its own per-process in-memory store, and an operator kill armed via the control plane
  // would silently no-op on the serving backend — defeating NN #4. Never boot prod without DATABASE_URL.
  if (process.env.PALUP_REQUIRE_DATABASE_URL === "true") {
    throw new Error(
      "PALUP_REQUIRE_DATABASE_URL=true but DATABASE_URL is unset — refusing to boot with a non-durable, " +
        "per-process store. Set DATABASE_URL to the shared Cloud SQL instance (NN #4: the kill switch " +
        "must halt every serving instance).",
    );
  }
  return { store: new InMemoryRuntimeStore(), kind: "memory" };
}
