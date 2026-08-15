import {
  requireCleanText,
  type VectorPort,
  type VectorRecord,
  type VectorQuery,
  type VectorMatch,
} from "@palup/platform-ports";
import type { Sql } from "./sql.js";

// pgvector-HNSW adapter for VectorPort (ADR-0020 D3 / A2). Sibling to PostgresVectorStore (brute-force),
// selected only under VECTOR_ANN. Vector-query ONLY (no lexical modality — pgvector has no Jaccard). All
// pgvector-isms stay in this file (ADR-0001). Erasure is one transactional DELETE (ADR-0015).

const VECTOR_INDEX_DIM_CAP = 2000; // pgvector `vector` HNSW cap; halfvec above it. RE-CONFIRMED against a
// live pgvector/pgvector:pg16 container (see task-2-report.md): `vector(D)` + `vector_cosine_ops` for
// D <= 2000, else `halfvec(D)` + `halfvec_cosine_ops`.

// Same pattern as the sibling adapter (postgres-vector-store.ts): a blank/missing namespace is a
// cross-tenant wildcard, so we fail closed rather than widen scope; `tenant_id` is a defense-in-depth
// column derived from widget-memory's Option B `${tenantId}::${anonId}` namespace scheme.
function requireNamespace(namespace: string): string {
  if (!namespace || !namespace.trim())
    throw new Error("VectorPort: a non-blank namespace is required (tenant isolation)");
  return namespace;
}

function tenantIdFromNamespace(namespace: string): string {
  const idx = namespace.indexOf("::");
  return idx === -1 ? namespace : namespace.slice(0, idx);
}

export class PgVectorTextQueryUnsupported extends Error {
  constructor() {
    super("PgVectorStore: text-modality queries are unsupported (vector-query-only ANN adapter)");
    this.name = "PgVectorTextQueryUnsupported";
  }
}

export class PgVectorStore implements VectorPort {
  private readonly dimension: number;
  private readonly efSearch: number;
  private readonly colType: string; // "vector" | "halfvec"
  private readonly opclass: string; // "vector_cosine_ops" | "halfvec_cosine_ops"

  constructor(private readonly sql: Sql, opts: { dimension: number; efSearch?: number }) {
    if (!Number.isInteger(opts.dimension) || opts.dimension < 1)
      throw new Error(`PgVectorStore: dimension must be a positive integer (got ${opts.dimension})`);
    this.dimension = opts.dimension;
    this.efSearch = opts.efSearch ?? 100;
    const half = opts.dimension > VECTOR_INDEX_DIM_CAP;
    this.colType = half ? "halfvec" : "vector";
    this.opclass = half ? "halfvec_cosine_ops" : "vector_cosine_ops";
  }

  async migrate(): Promise<void> {
    await this.sql.query("CREATE EXTENSION IF NOT EXISTS vector");
    await this.sql.query(
      `CREATE TABLE IF NOT EXISTS vp_ann (
         namespace text NOT NULL, tenant_id text NOT NULL, id text NOT NULL,
         embedding ${this.colType}(${this.dimension}) NOT NULL, metadata jsonb,
         PRIMARY KEY (namespace, id))`,
    );
    await this.sql.query(
      `CREATE INDEX IF NOT EXISTS vp_ann_hnsw ON vp_ann USING hnsw (embedding ${this.opclass}) WITH (m = 16, ef_construction = 64)`,
    );
    await this.sql.query("CREATE INDEX IF NOT EXISTS vp_ann_tenant ON vp_ann (tenant_id)");
  }

  async upsert(namespace: string, records: VectorRecord[]): Promise<void> {
    const ns = requireNamespace(namespace);
    if (records.length === 0) return;
    for (const rec of records) {
      requireCleanText(rec.text);
      if (!rec.vector || rec.vector.length !== this.dimension)
        throw new Error(
          `PgVectorStore: record "${rec.id}" must carry a vector of dimension ${this.dimension} ` +
            `(got ${rec.vector ? rec.vector.length : "none"}) — refusing to store (fail closed)`,
        );
    }
    const tenantId = tenantIdFromNamespace(ns);
    await this.sql.tx(async (tx) => {
      for (const rec of records) {
        await tx.query(
          `INSERT INTO vp_ann (namespace, tenant_id, id, embedding, metadata)
           VALUES ($1,$2,$3,$4::${this.colType}(${this.dimension}),$5)
           ON CONFLICT (namespace, id) DO UPDATE SET embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata`,
          [ns, tenantId, rec.id, JSON.stringify(rec.vector), rec.metadata !== undefined ? JSON.stringify(rec.metadata) : null],
        );
      }
    });
  }
  async query(namespace: string, query: VectorQuery): Promise<VectorMatch[]> {
    const ns = requireNamespace(namespace);
    if (!query.vector) throw new PgVectorTextQueryUnsupported();
    const k = query.k != null ? Math.max(0, Math.floor(query.k)) : 0;
    if (k === 0) return [];
    const q = JSON.stringify(query.vector);
    // SET LOCAL requires a transaction; run the ANN search inside one so ef_search never leaks to a
    // pooled connection. Score = cosine similarity (1 - cosine distance) to match scoreRecord semantics.
    return this.sql.tx(async (tx) => {
      await tx.query(`SET LOCAL hnsw.ef_search = ${Math.floor(this.efSearch)}`);
      const { rows } = await tx.query<{ id: string; score: number | string; metadata: Record<string, unknown> | null }>(
        `SELECT id, 1 - (embedding <=> $1::${this.colType}(${this.dimension})) AS score, metadata
         FROM vp_ann WHERE namespace = $2
         ORDER BY embedding <=> $1::${this.colType}(${this.dimension}), id
         LIMIT $3`,
        [q, ns, k],
      );
      return rows.map((r) => ({ id: r.id, score: Number(r.score), metadata: r.metadata ?? undefined }));
    });
  }
  async deleteById(): Promise<void> {
    throw new Error("PgVectorStore: not implemented");
  }
  async deleteNamespace(): Promise<void> {
    throw new Error("PgVectorStore: not implemented");
  }
}
