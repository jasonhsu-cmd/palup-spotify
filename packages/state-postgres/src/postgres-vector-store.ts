import { scoreRecord, type VectorPort, type VectorRecord, type VectorQuery, type VectorMatch } from "@palup/platform-ports";
import type { Sql } from "./sql.js";

// Postgres adapter for VectorPort (ADR-0001 `vector` port; go-live blocker #1 — durable, portable
// cross-visit memory). Mirrors PostgresRuntimeStore's discipline exactly: namespace is a BOUND parameter
// on every statement (never string-interpolated), and a blank/missing namespace fails closed via the
// SAME guard pattern as the in-memory oracle (vector-port.ts) and PostgresRuntimeStore's tenant guard.
// Table keyed by (namespace, id); `text` and `metadata` are stored as-is, `vector` as jsonb (a Postgres
// `double precision[]` column round-trips fine too, but jsonb is the SAME proven encoding
// PostgresRuntimeStore already uses for `rs_kv.value` — reusing a working pattern rather than
// introducing a second one this file would be the only user of).
//
// HONEST SEMANTICS NOTE — READ BEFORE ASSUMING THIS IS AN ANN/VECTOR-SEARCH ENGINE: it is not. `query`
// does NOT run a vector index / approximate-nearest-neighbor search. It fetches every row in the
// namespace and RE-SCORES them in application code with platform-ports' exported `scoreRecord` — the
// EXACT SAME cosine-similarity / lexical-Jaccard function the in-memory oracle uses — so ranking is
// byte-identical to the oracle, just computed by a SQL scan + JS sort instead of a Map iteration. That is
// a deliberate, documented choice, not a shortcut standing in for a missing feature:
//   - FAST-V1 (packages/widget-memory) deliberately DROPPED embeddings/ANN from scope (see service.ts /
//     erasure.ts doc comments). Its ONLY real query pattern is `query(namespace, {text: "", k: 500})` —
//     "list everything for this subject" — where every record ties at score 0 (lexical() on an empty
//     query token set) and the tie-break is stable id order. A full-namespace scan is EXACTLY correct
//     and cheap for that pattern at the modest per-subject record counts this system deals in (capped at
//     500 by the caller).
//   - For a genuinely non-empty vector/text query this still computes REAL cosine/Jaccard ranking (not a
//     stub), it is just O(records in namespace) rather than backed by an index — fine at this scale,
//     NOT a claim of ANN/approximate search or of scaling to large per-tenant corpora.
// If a future need requires real ANN at scale (pgvector, a managed vector DB, …), that is a NEW adapter
// behind this SAME port (ADR-0001) — do not bolt an index onto this file and call it done without
// updating this comment; a reader must never come away believing this does semantic vector search over
// an index.

function requireNamespace(namespace: string): string {
  if (!namespace || !namespace.trim())
    throw new Error("VectorPort: a non-blank namespace is required (tenant isolation)");
  return namespace;
}

interface VpRow {
  id: string;
  vector: number[] | null;
  text: string | null;
  metadata: Record<string, unknown> | null;
}

export class PostgresVectorStore implements VectorPort {
  constructor(private readonly sql: Sql) {}

  /** Create the table if absent. Idempotent; run at startup / in a migration step (mirrors
   *  PostgresRuntimeStore.migrate()). */
  async migrate(): Promise<void> {
    await this.sql.query(
      `CREATE TABLE IF NOT EXISTS vp_records (
         namespace text NOT NULL, id text NOT NULL, vector jsonb, text text, metadata jsonb,
         PRIMARY KEY (namespace, id))`,
    );
  }

  async upsert(namespace: string, records: VectorRecord[]): Promise<void> {
    const ns = requireNamespace(namespace);
    for (const rec of records) {
      await this.sql.query(
        `INSERT INTO vp_records (namespace, id, vector, text, metadata)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (namespace, id) DO UPDATE SET vector = EXCLUDED.vector, text = EXCLUDED.text, metadata = EXCLUDED.metadata`,
        [
          ns,
          rec.id,
          rec.vector != null ? JSON.stringify(rec.vector) : null,
          rec.text ?? null,
          rec.metadata !== undefined ? JSON.stringify(rec.metadata) : null,
        ],
      );
    }
  }

  async query(namespace: string, query: VectorQuery): Promise<VectorMatch[]> {
    const ns = requireNamespace(namespace);
    const { rows } = await this.sql.query<VpRow>(
      "SELECT id, vector, text, metadata FROM vp_records WHERE namespace=$1",
      [ns],
    );
    // Brute-force re-score in app code with the SHARED scoreRecord — see the file-level honesty note.
    const scored: VectorMatch[] = rows.map((r) => ({
      id: r.id,
      score: scoreRecord(query, { id: r.id, vector: r.vector ?? undefined, text: r.text ?? undefined }),
      metadata: r.metadata ?? undefined,
    }));
    scored.sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    const limit = query.k != null ? Math.max(0, Math.floor(query.k)) : scored.length;
    return scored.slice(0, limit);
  }

  async deleteById(namespace: string, ids: string[]): Promise<void> {
    const ns = requireNamespace(namespace);
    if (ids.length === 0) return;
    await this.sql.query("DELETE FROM vp_records WHERE namespace=$1 AND id = ANY($2::text[])", [ns, ids]);
  }

  async deleteNamespace(namespace: string): Promise<void> {
    const ns = requireNamespace(namespace);
    await this.sql.query("DELETE FROM vp_records WHERE namespace=$1", [ns]);
  }
}
