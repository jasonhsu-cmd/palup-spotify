import type { VectorPort, VectorMatch } from "@palup/platform-ports";
import type { Sql } from "./sql.js";

// pgvector-HNSW adapter for VectorPort (ADR-0020 D3 / A2). Sibling to PostgresVectorStore (brute-force),
// selected only under VECTOR_ANN. Vector-query ONLY (no lexical modality — pgvector has no Jaccard). All
// pgvector-isms stay in this file (ADR-0001). Erasure is one transactional DELETE (ADR-0015).

const VECTOR_INDEX_DIM_CAP = 2000; // pgvector `vector` HNSW cap; halfvec above it. RE-CONFIRMED against a
// live pgvector/pgvector:pg16 container (see task-2-report.md): `vector(D)` + `vector_cosine_ops` for
// D <= 2000, else `halfvec(D)` + `halfvec_cosine_ops`.

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

  async upsert(): Promise<void> {
    throw new Error("PgVectorStore: not implemented");
  }
  async query(): Promise<VectorMatch[]> {
    throw new Error("PgVectorStore: not implemented");
  }
  async deleteById(): Promise<void> {
    throw new Error("PgVectorStore: not implemented");
  }
  async deleteNamespace(): Promise<void> {
    throw new Error("PgVectorStore: not implemented");
  }
}
