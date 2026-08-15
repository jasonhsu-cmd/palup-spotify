# S1 — pgvector-HNSW engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real ANN vector engine (`PgVectorStore`, pgvector-HNSW) behind the unchanged `VectorPort`, shipping dark, so later sub-projects can serve large catalogs from it.

**Architecture:** A new Postgres adapter mirrors the existing brute-force `PostgresVectorStore` (same `Sql` abstraction, same namespace/tenant guards) but stores embeddings in a native `vector(D)` column with an HNSW cosine index and queries via `<=> ` ANN instead of an app-code re-score. It is vector-query-only. It is selected only when a new `VECTOR_ANN` env flag is on (default off; brute-force stays the default). All pgvector-isms stay inside the adapter behind the port (ADR-0001).

**Tech Stack:** TypeScript (tsx, no build), vitest, `pg` via the repo's `Sql` abstraction, pgvector (`pgvector/pgvector:pg16`) via a testcontainer, existing `@palup/platform-ports` `VectorPort`.

**Spec:** `docs/superpowers/specs/2026-08-15-catalog-retrieval-scale-design.md` (§4 is S1). Read it with this plan.

## Global Constraints

- **Test-first (ATDD):** every task writes a failing test, sees it red, implements to green, commits.
- **NEVER set `GOOGLE_CLOUD_PROJECT`** in any command. Run tests with `env -u GOOGLE_CLOUD_PROJECT pnpm vitest run <file>`.
- **Ships dark; no HITL boundary.** `VECTOR_ANN` defaults **off**; brute-force/in-memory selection is byte-identical when off. Do NOT flip `CATALOG_RETRIEVAL` or any governance flag.
- **Portability (ADR-0001):** pgvector types/SQL (`vector`/`halfvec`, `<=>`, `hnsw`, `vector_cosine_ops`, `hnsw.ef_search`) live ONLY inside `PgVectorStore`. No native vector SQL in feature code.
- **`VectorPort` is unchanged** (`packages/platform-ports/src/vector-port.ts:43-53`): `upsert(namespace, VectorRecord[])`, `query(namespace, VectorQuery) → VectorMatch[]`, `deleteById(namespace, ids)`, `deleteNamespace(namespace)`. Types: `VectorRecord{id; vector?:number[]; text?:string; metadata?}`, `VectorQuery{vector?; text?; k}`, `VectorMatch{id; score; metadata?}` (`:21-41`).
- **Reuse the shared helpers** exported from `@palup/platform-ports`: `requireCleanText(text)` (throws on control/lone-surrogate) and, where the modality matches, `scoreRecord`. Namespace guard + `tenantIdFromNamespace` follow `postgres-vector-store.ts:64-80` exactly (bound `$1`, never interpolated).
- **Erasure (ADR-0015):** `deleteById`/`deleteNamespace` are single transactional in-engine `DELETE`s.
- **pgvector facts to RE-CONFIRM at build** against the pgvector README (ADR-0020 fact-checked them 2026-08-07): `vector` HNSW dimension cap = **2000**, `halfvec` cap = **4000** (pgvector ≥0.7.0); the cosine distance operator is `<=>`; index opclasses are `vector_cosine_ops` / `halfvec_cosine_ops`; query-time recall knob is the `hnsw.ef_search` GUC; text input format for a vector is `[1,2,3]` (which `JSON.stringify(number[])` produces). If any differs, fix the DDL/SQL and note it.
- **Target dimension D = 1536** in production wiring; the adapter takes D as a constructor param and tests use small D (e.g. 4 or 8) for speed.

---

### Task 1: pgvector testcontainer test harness

**Files:**
- Create: `packages/state-postgres/test/helpers/pgvector-container.ts`
- Test: `packages/state-postgres/test/pgvector-container.smoke.test.ts`

**Interfaces:**
- Produces: `withPgvector(fn: (sql: Sql) => Promise<void>): Promise<void>` — boots a `pgvector/pgvector:pg16` container, hands an `Sql` (from `pgPoolSqlFromUrl`) bound to it, tears it down after. Also `export const PGVECTOR_AVAILABLE: boolean` — true when Docker is reachable (used to `describe.skipIf` locally; the merge-gate REQUIRES it true).
- Consumes: `pgPoolSqlFromUrl`, `Sql` from `packages/state-postgres/src/sql.js`.

- [ ] **Step 1: Write the failing smoke test**

```ts
// packages/state-postgres/test/pgvector-container.smoke.test.ts
import { describe, it, expect } from "vitest";
import { withPgvector, PGVECTOR_AVAILABLE } from "./helpers/pgvector-container.js";

describe.skipIf(!PGVECTOR_AVAILABLE)("pgvector testcontainer", () => {
  it("boots Postgres with the vector extension available", async () => {
    await withPgvector(async (sql) => {
      await sql.query("CREATE EXTENSION IF NOT EXISTS vector");
      const { rows } = await sql.query<{ ok: number }>("SELECT 1 AS ok");
      expect(rows[0]!.ok).toBe(1);
      const ext = await sql.query<{ extname: string }>(
        "SELECT extname FROM pg_extension WHERE extname = 'vector'",
      );
      expect(ext.rows.map((r) => r.extname)).toContain("vector");
    });
  }, 120_000);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm vitest run packages/state-postgres/test/pgvector-container.smoke.test.ts`
Expected: FAIL — `withPgvector` / `PGVECTOR_AVAILABLE` not found.

- [ ] **Step 3: Implement the harness**

Use the `testcontainers` npm package if already a dev dependency; otherwise add it as a **devDependency** of `@palup/state-postgres` (ask before adding — the repo restricts new deps; `testcontainers` is test-only). `PGVECTOR_AVAILABLE` = a cheap Docker-reachability check (e.g. `process.env.PGVECTOR_TESTCONTAINER !== "off"` AND a `docker info` probe wrapped in try/catch; default the probe to the check the gate relies on). Boot the container, build a URL, hand back `pgPoolSqlFromUrl(url)`, ensure teardown in a `finally`.

```ts
// packages/state-postgres/test/helpers/pgvector-container.ts
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { pgPoolSqlFromUrl, type Sql } from "../../src/sql.js";

// Docker reachability: the merge-gate sets PGVECTOR_TESTCONTAINER unset (⇒ required);
// a dev without Docker may set PGVECTOR_TESTCONTAINER=off to skip locally.
export const PGVECTOR_AVAILABLE = process.env.PGVECTOR_TESTCONTAINER !== "off";

export async function withPgvector(fn: (sql: Sql) => Promise<void>): Promise<void> {
  let container: StartedTestContainer | undefined;
  try {
    container = await new GenericContainer("pgvector/pgvector:pg16")
      .withEnvironment({ POSTGRES_PASSWORD: "test", POSTGRES_DB: "palup" })
      .withExposedPorts(5432)
      .start();
    const url = `postgres://postgres:test@${container.getHost()}:${container.getMappedPort(5432)}/palup`;
    const sql = pgPoolSqlFromUrl(url);
    await fn(sql);
  } finally {
    await container?.stop();
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm vitest run packages/state-postgres/test/pgvector-container.smoke.test.ts`
Expected: PASS (Docker must be running). If `testcontainers` is missing, install it first.

- [ ] **Step 5: Commit**

```bash
git add packages/state-postgres/test/helpers/pgvector-container.ts packages/state-postgres/test/pgvector-container.smoke.test.ts
git commit -m "test(state-postgres): pgvector testcontainer harness for the ANN adapter"
```

---

### Task 2: `PgVectorStore` skeleton + `migrate()`

**Files:**
- Create: `packages/state-postgres/src/pgvector-store.ts`
- Test: `packages/state-postgres/test/pgvector-store.migrate.test.ts`

**Interfaces:**
- Produces: `class PgVectorStore implements VectorPort` with `constructor(sql: Sql, opts: { dimension: number; efSearch?: number })` and `async migrate(): Promise<void>`. `upsert`/`query`/`deleteById`/`deleteNamespace` exist but throw `"PgVectorStore: not implemented"` until later tasks.
- Consumes: `Sql` (`.query`, `.tx`) from `./sql.js`; `VectorPort` etc. from `@palup/platform-ports`.

- [ ] **Step 1: Write the failing test** (migrate is idempotent; creates extension, table, HNSW + tenant indexes)

```ts
// packages/state-postgres/test/pgvector-store.migrate.test.ts
import { describe, it, expect } from "vitest";
import { withPgvector, PGVECTOR_AVAILABLE } from "./helpers/pgvector-container.js";
import { PgVectorStore } from "../src/pgvector-store.js";

describe.skipIf(!PGVECTOR_AVAILABLE)("PgVectorStore.migrate", () => {
  it("creates the extension, vp_ann(vector(D)), and an HNSW cosine index — idempotently", async () => {
    await withPgvector(async (sql) => {
      const store = new PgVectorStore(sql, { dimension: 4 });
      await store.migrate();
      await store.migrate(); // idempotent — second run must not throw

      const cols = await sql.query<{ udt: string }>(
        "SELECT udt_name AS udt FROM information_schema.columns WHERE table_name='vp_ann' AND column_name='embedding'",
      );
      expect(cols.rows[0]!.udt).toBe("vector");
      const idx = await sql.query<{ indexdef: string }>(
        "SELECT indexdef FROM pg_indexes WHERE tablename='vp_ann'",
      );
      const defs = idx.rows.map((r) => r.indexdef).join("\n");
      expect(defs).toMatch(/USING hnsw/i);
      expect(defs).toMatch(/vector_cosine_ops/i);
    }, 120_000);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm vitest run packages/state-postgres/test/pgvector-store.migrate.test.ts`
Expected: FAIL — `PgVectorStore` not found.

- [ ] **Step 3: Implement the skeleton + migrate**

Dimension chooses the column type + opclass: `D ≤ 2000 → vector(D)` + `vector_cosine_ops`; `D > 2000 → halfvec(D)` + `halfvec_cosine_ops` (per Global Constraints; re-confirm caps). `migrate()` is idempotent (`IF NOT EXISTS`).

```ts
// packages/state-postgres/src/pgvector-store.ts
import { requireCleanText, type VectorPort, type VectorRecord, type VectorQuery, type VectorMatch } from "@palup/platform-ports";
import type { Sql } from "./sql.js";

// pgvector-HNSW adapter for VectorPort (ADR-0020 D3 / A2). Sibling to PostgresVectorStore (brute-force),
// selected only under VECTOR_ANN. Vector-query ONLY (no lexical modality — pgvector has no Jaccard). All
// pgvector-isms stay in this file (ADR-0001). Erasure is one transactional DELETE (ADR-0015).

const VECTOR_INDEX_DIM_CAP = 2000; // pgvector `vector` HNSW cap; halfvec above it. RE-CONFIRM (README).

export class PgVectorTextQueryUnsupported extends Error {
  constructor() {
    super("PgVectorStore: text-modality queries are unsupported (vector-query-only ANN adapter)");
    this.name = "PgVectorTextQueryUnsupported";
  }
}

function requireNamespace(namespace: string): string {
  if (!namespace || !namespace.trim())
    throw new Error("VectorPort: a non-blank namespace is required (tenant isolation)");
  return namespace;
}
function tenantIdFromNamespace(namespace: string): string {
  const idx = namespace.indexOf("::");
  return idx === -1 ? namespace : namespace.slice(0, idx);
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

  async upsert(): Promise<void> { throw new Error("PgVectorStore: not implemented"); }
  async query(): Promise<VectorMatch[]> { throw new Error("PgVectorStore: not implemented"); }
  async deleteById(): Promise<void> { throw new Error("PgVectorStore: not implemented"); }
  async deleteNamespace(): Promise<void> { throw new Error("PgVectorStore: not implemented"); }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm vitest run packages/state-postgres/test/pgvector-store.migrate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/state-postgres/src/pgvector-store.ts packages/state-postgres/test/pgvector-store.migrate.test.ts
git commit -m "feat(state-postgres): PgVectorStore skeleton + idempotent HNSW migrate (dark)"
```

---

### Task 3: `upsert` (dimension guard + clean-text + transactional)

**Files:**
- Modify: `packages/state-postgres/src/pgvector-store.ts` (replace the `upsert` stub)
- Test: `packages/state-postgres/test/pgvector-store.upsert.test.ts`

**Interfaces:**
- Produces: `upsert(namespace, records)` — `requireNamespace`; per record `requireCleanText(rec.text)`; **dimension guard** — reject any record whose `vector` is absent or `vector.length !== dimension` with a fail-closed error; write `embedding` from `JSON.stringify(vector)` cast `$::${colType}`; `metadata` as jsonb; one transaction (all-or-nothing) with `ON CONFLICT (namespace,id) DO UPDATE`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/state-postgres/test/pgvector-store.upsert.test.ts
import { describe, it, expect } from "vitest";
import { withPgvector, PGVECTOR_AVAILABLE } from "./helpers/pgvector-container.js";
import { PgVectorStore } from "../src/pgvector-store.js";

const migrated = async (sql: any, dimension = 4) => {
  const s = new PgVectorStore(sql, { dimension });
  await s.migrate();
  return s;
};

describe.skipIf(!PGVECTOR_AVAILABLE)("PgVectorStore.upsert", () => {
  it("stores a dimension-D vector + metadata and overwrites on same id", async () => {
    await withPgvector(async (sql) => {
      const s = await migrated(sql);
      await s.upsert("t", [{ id: "a", vector: [1, 0, 0, 0], metadata: { rev: 1 } }]);
      await s.upsert("t", [{ id: "a", vector: [0, 1, 0, 0], metadata: { rev: 2 } }]);
      const { rows } = await sql.query("SELECT id, metadata FROM vp_ann WHERE namespace='t'");
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toEqual({ rev: 2 });
    }, 120_000);
  });

  it("REJECTS a wrong-dimension or vectorless record (fail closed)", async () => {
    await withPgvector(async (sql) => {
      const s = await migrated(sql);
      await expect(s.upsert("t", [{ id: "b", vector: [1, 0, 0] }])).rejects.toThrow(/dimension/i);
      await expect(s.upsert("t", [{ id: "c", metadata: { x: 1 } }])).rejects.toThrow(/dimension/i);
    }, 120_000);
  });

  it("rejects control-char text (shared requireCleanText) and blank namespace", async () => {
    await withPgvector(async (sql) => {
      const s = await migrated(sql);
      const NUL = String.fromCharCode(0);
      await expect(s.upsert("t", [{ id: "d", vector: [1, 0, 0, 0], text: `x${NUL}y` }])).rejects.toThrow(/control character|surrogate/i);
      await expect(s.upsert("", [{ id: "e", vector: [1, 0, 0, 0] }])).rejects.toThrow(/namespace/i);
    }, 120_000);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm vitest run packages/state-postgres/test/pgvector-store.upsert.test.ts`
Expected: FAIL — `not implemented`.

- [ ] **Step 3: Implement `upsert`**

```ts
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm vitest run packages/state-postgres/test/pgvector-store.upsert.test.ts`
Expected: PASS. (If the `$4::vector(D)` cast is rejected, cast to bare `::vector`/`::halfvec` and re-confirm the pgvector literal format.)

- [ ] **Step 5: Commit**

```bash
git add packages/state-postgres/src/pgvector-store.ts packages/state-postgres/test/pgvector-store.upsert.test.ts
git commit -m "feat(state-postgres): PgVectorStore.upsert — dim guard + clean-text + transactional"
```

---

### Task 4: `query` (HNSW cosine, vector-only, ef_search)

**Files:**
- Modify: `packages/state-postgres/src/pgvector-store.ts` (replace the `query` stub)
- Test: `packages/state-postgres/test/pgvector-store.query.test.ts`

**Interfaces:**
- Produces: `query(namespace, {vector?, text?, k})` — throws `PgVectorTextQueryUnsupported` when `vector` is absent and `text` is present; `requireNamespace`; unknown namespace → `[]`; sets `hnsw.ef_search` (SET LOCAL, inside a tx) and returns `VectorMatch[]` ordered nearest-first with `score = 1 - (embedding <=> q)`, tie-broken by id, capped at `k`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/state-postgres/test/pgvector-store.query.test.ts
import { describe, it, expect } from "vitest";
import { withPgvector, PGVECTOR_AVAILABLE } from "./helpers/pgvector-container.js";
import { PgVectorStore, PgVectorTextQueryUnsupported } from "../src/pgvector-store.js";

describe.skipIf(!PGVECTOR_AVAILABLE)("PgVectorStore.query", () => {
  it("returns nearest-first by cosine, honors k, round-trips metadata", async () => {
    await withPgvector(async (sql) => {
      const s = new PgVectorStore(sql, { dimension: 3, efSearch: 100 });
      await s.migrate();
      await s.upsert("t", [
        { id: "r3", vector: [0, 1, 0], metadata: { t: "far" } },
        { id: "r1", vector: [1, 0, 0], metadata: { t: "exact" } },
        { id: "r2", vector: [0.8, 0.6, 0], metadata: { t: "near" } },
      ]);
      const hits = await s.query("t", { vector: [1, 0, 0], k: 3 });
      expect(hits.map((h) => h.id)).toEqual(["r1", "r2", "r3"]); // ef_search=100 >> 3 ⇒ exact
      expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
      expect(hits[0]!.metadata).toEqual({ t: "exact" });
      expect((await s.query("t", { vector: [1, 0, 0], k: 2 })).map((h) => h.id)).toEqual(["r1", "r2"]);
    }, 120_000);
  });

  it("throws PgVectorTextQueryUnsupported for a text-only query; unknown namespace ⇒ []", async () => {
    await withPgvector(async (sql) => {
      const s = new PgVectorStore(sql, { dimension: 3 });
      await s.migrate();
      await expect(s.query("t", { text: "hi", k: 3 })).rejects.toBeInstanceOf(PgVectorTextQueryUnsupported);
      expect(await s.query("never-seen", { vector: [1, 0, 0], k: 5 })).toEqual([]);
    }, 120_000);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm vitest run packages/state-postgres/test/pgvector-store.query.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `query`**

```ts
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
    const { rows } = await tx.query<{ id: string; score: number; metadata: Record<string, unknown> | null }>(
      `SELECT id, 1 - (embedding <=> $1::${this.colType}(${this.dimension})) AS score, metadata
       FROM vp_ann WHERE namespace = $2
       ORDER BY embedding <=> $1::${this.colType}(${this.dimension}), id
       LIMIT $3`,
      [q, ns, k],
    );
    return rows.map((r) => ({ id: r.id, score: Number(r.score), metadata: r.metadata ?? undefined }));
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm vitest run packages/state-postgres/test/pgvector-store.query.test.ts`
Expected: PASS. (If `score` comes back as a string, `Number(r.score)` already coerces it; if `<=>` needs a bare `::vector` cast, adjust and re-confirm.)

- [ ] **Step 5: Commit**

```bash
git add packages/state-postgres/src/pgvector-store.ts packages/state-postgres/test/pgvector-store.query.test.ts
git commit -m "feat(state-postgres): PgVectorStore.query — HNSW cosine, vector-only, ef_search"
```

---

### Task 5: `deleteById` + `deleteNamespace` (transactional erasure)

**Files:**
- Modify: `packages/state-postgres/src/pgvector-store.ts` (replace the two delete stubs)
- Test: `packages/state-postgres/test/pgvector-store.erasure.test.ts`

**Interfaces:**
- Produces: `deleteById(ns, ids)` — bound `namespace=$1 AND id = ANY($2::text[])`; `deleteNamespace(ns)` — bound `namespace=$1`. Both `requireNamespace`; single `DELETE` each (mirrors `postgres-vector-store.ts:174-183`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/state-postgres/test/pgvector-store.erasure.test.ts
import { describe, it, expect } from "vitest";
import { withPgvector, PGVECTOR_AVAILABLE } from "./helpers/pgvector-container.js";
import { PgVectorStore } from "../src/pgvector-store.js";

describe.skipIf(!PGVECTOR_AVAILABLE)("PgVectorStore erasure + isolation", () => {
  it("deleteById removes only given ids; deleteNamespace erases the tenant; namespaces isolated", async () => {
    await withPgvector(async (sql) => {
      const s = new PgVectorStore(sql, { dimension: 2, efSearch: 100 });
      await s.migrate();
      await s.upsert("A", [{ id: "a", vector: [1, 0] }, { id: "b", vector: [0, 1] }]);
      await s.upsert("B", [{ id: "b-only", vector: [1, 0] }]);
      await s.deleteById("A", ["a", "missing"]);
      expect((await s.query("A", { vector: [1, 0], k: 9 })).map((h) => h.id)).toEqual(["b"]);
      await s.deleteNamespace("A");
      expect(await s.query("A", { vector: [1, 0], k: 9 })).toEqual([]);
      expect((await s.query("B", { vector: [1, 0], k: 9 })).map((h) => h.id)).toEqual(["b-only"]);
    }, 120_000);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `env -u GOOGLE_CLOUD_PROJECT pnpm vitest run packages/state-postgres/test/pgvector-store.erasure.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
async deleteById(namespace: string, ids: string[]): Promise<void> {
  const ns = requireNamespace(namespace);
  if (ids.length === 0) return;
  await this.sql.query("DELETE FROM vp_ann WHERE namespace=$1 AND id = ANY($2::text[])", [ns, ids]);
}
async deleteNamespace(namespace: string): Promise<void> {
  const ns = requireNamespace(namespace);
  await this.sql.query("DELETE FROM vp_ann WHERE namespace=$1", [ns]);
}
```

- [ ] **Step 4: Run to verify it passes** — same command → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/state-postgres/src/pgvector-store.ts packages/state-postgres/test/pgvector-store.erasure.test.ts
git commit -m "feat(state-postgres): PgVectorStore erasure (by id + by namespace), transactional"
```

---

### Task 6: ANN behavioral contract + recall spot-check

**Files:**
- Create: `packages/platform-ports/src/contract/vector-port-ann.contract.ts`
- Test: `packages/state-postgres/test/pgvector-store.contract.test.ts`

**Interfaces:**
- Produces: `runVectorPortAnnContract(makeAdapter: () => VectorPort | Promise<VectorPort>, dimension: number): void` — a sibling to `runVectorPortContract` (`contract/vector-port.contract.ts`) for a **vector-only** adapter: asserts the behavioral core (namespace guard, unknown-ns → [], isolation, deleteById, deleteNamespace, overwrite, metadata round-trip, metadata independence, proto/constructor ids) using **vector** queries at `dimension`, plus a `text`-query-throws assertion, plus a recall spot-check on ~5k synthetic vectors (recall@10 above a floor). Reuses no text-modality assertions (pgvector has no lexical).
- **Note (spec refinement):** the spec §4.6 suggested parameterizing the existing contract with `{exactOrdering, textModality}`; the existing contract is text-query-heavy and mixes vector dimensions, so a **sibling** contract (this) is used instead — same coverage goal, zero risk to the in-memory/brute-force callers.

- [ ] **Step 1: Write the failing test** (wires the ANN adapter into the contract)

```ts
// packages/state-postgres/test/pgvector-store.contract.test.ts
import { describe } from "vitest";
import { runVectorPortAnnContract } from "@palup/platform-ports/contract/vector-port-ann.contract.js";
import { withPgvector, PGVECTOR_AVAILABLE } from "./helpers/pgvector-container.js";
import { PgVectorStore } from "../src/pgvector-store.js";

// Each contract `it` needs a fresh, empty adapter. We boot one container for the file and use a fresh
// namespace-empty adapter by truncating vp_ann between makes — cheapest correct approach for a shared container.
describe.skipIf(!PGVECTOR_AVAILABLE)("PgVectorStore — ANN contract", () => {
  runVectorPortAnnContract(async () => {
    // Implementation detail: return an adapter over a freshly-migrated, truncated table.
    // (Container lifecycle handled by a beforeAll/afterAll in the real test — see Step 3.)
    throw new Error("wired in Step 3");
  }, 8);
});
```

- [ ] **Step 2: Run to verify it fails** — the import of `runVectorPortAnnContract` fails (module missing) → FAIL.

- [ ] **Step 3: Implement the ANN contract + wire the test**

Write `runVectorPortAnnContract` mirroring the modality-agnostic assertions of `vector-port.contract.ts` but with vector fixtures of `dimension` (build unit-ish vectors, e.g. `e(i)=one-hot at i` for i<dimension) and the two ANN-specific tests. Then, in the test file, manage the container with `beforeAll`/`afterAll`, and make `makeAdapter` migrate once and `TRUNCATE vp_ann` per call so each `it` starts empty. Recall spot-check: insert ~5000 random dimension-`D` vectors + one planted near-duplicate of a query, assert the planted id is within the top-10 (recall floor), not exact ordering.

Exact assertions to include (all vector-mode): overwrite→1 row; deleteById→remaining; deleteNamespace→[]; unknown-ns→[]; blank-ns throws on every op; isolation (A vs B, erase A leaves B); metadata deep round-trip via a vector query; metadata independent of caller mutation; `__proto__`/`constructor` ids treated literally; `query({text},…)` throws `PgVectorTextQueryUnsupported`; recall@10 ≥ floor on 5k.

- [ ] **Step 4: Run to verify it passes** — `env -u GOOGLE_CLOUD_PROJECT pnpm vitest run packages/state-postgres/test/pgvector-store.contract.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/platform-ports/src/contract/vector-port-ann.contract.ts packages/state-postgres/test/pgvector-store.contract.test.ts
git commit -m "test(vector): ANN behavioral contract + recall spot-check for PgVectorStore"
```

---

### Task 7: `VECTOR_ANN` selection in `createVectorStore` (ships dark)

**Files:**
- Modify: `packages/state-postgres/src/vector-factory.ts:24-44`
- Test: `packages/state-postgres/test/vector-factory.ann.test.ts`

**Interfaces:**
- Consumes: `PgVectorStore` (Task 2). `createVectorStore(sql?)` unchanged signature.
- Produces: when `DATABASE_URL` set **and** `process.env.VECTOR_ANN === "true"`, returns `{ store: new PgVectorStore(...), kind: "ann" }` (dimension from `PALUP_EMBED_DIMENSION` or default 1536; `HNSW_EF_SEARCH` optional). Otherwise **byte-identical** to today.

- [ ] **Step 1: Write the failing tests** (flag off ⇒ unchanged; flag on ⇒ ann kind)

```ts
// packages/state-postgres/test/vector-factory.ann.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { createVectorStore } from "../src/vector-factory.js";

const reset = () => { delete process.env.DATABASE_URL; delete process.env.VECTOR_ANN; delete process.env.PALUP_REQUIRE_DATABASE_URL; };
afterEach(reset);

describe("createVectorStore VECTOR_ANN selection (dark)", () => {
  it("flag OFF with no DATABASE_URL ⇒ in-memory (unchanged)", async () => {
    reset();
    expect((await createVectorStore()).kind).toBe("memory");
  });
  it("flag ON but no DATABASE_URL ⇒ still NOT ann (ann requires a durable url)", async () => {
    reset(); process.env.VECTOR_ANN = "true";
    expect((await createVectorStore()).kind).toBe("memory");
  });
});
```

(An `ann`-kind assertion with a real DB is covered by the container-backed adapter tests; here we assert the *selection logic* without a live DB — construct-only, no `migrate()` call when unreachable. Ensure the factory does not `await migrate()` on a bogus URL in this unit test: the `kind:"ann"` branch, like the postgres branch, calls `migrate()`, so an ann-on-with-DATABASE_URL assertion belongs in a container test, not here.)

- [ ] **Step 2: Run to verify it fails** — behavior differs only once implemented; run and confirm current code passes the OFF cases and the ON-without-url case (it already returns memory today). If both already pass, ADD the real ann-selection assertion to the container-backed `vector-factory` test instead and see it fail there. Command: `env -u GOOGLE_CLOUD_PROJECT pnpm vitest run packages/state-postgres/test/vector-factory.ann.test.ts`.

- [ ] **Step 3: Implement the branch**

```ts
// inside createVectorStore, within `if (url) { ... }`, BEFORE the brute-force PostgresVectorStore branch:
if (process.env.VECTOR_ANN === "true") {
  const dimension = Number(process.env.PALUP_EMBED_DIMENSION ?? 1536);
  const efSearch = process.env.HNSW_EF_SEARCH ? Number(process.env.HNSW_EF_SEARCH) : undefined;
  const store = new PgVectorStore(sql ?? pgPoolSqlFromUrl(url), { dimension, efSearch });
  await store.migrate();
  return { store, kind: "ann" };
}
```

Add `import { PgVectorStore } from "./pgvector-store.js";`. Leave the brute-force + fail-fast + in-memory branches untouched.

- [ ] **Step 4: Run to verify it passes** — the unit test passes; add/confirm a container-backed `kind:"ann"` assertion (reuse `withPgvector` and set `DATABASE_URL` + `VECTOR_ANN` around the call). Command as above.

- [ ] **Step 5: Commit**

```bash
git add packages/state-postgres/src/vector-factory.ts packages/state-postgres/test/vector-factory.ann.test.ts
git commit -m "feat(state-postgres): select PgVectorStore behind VECTOR_ANN (default off, dark)"
```

---

### Task 8: Wire the pgvector suite into the merge-gate (in lockstep with ci.yml)

**Files:**
- Modify: `.claude/scripts/merge-gate.sh` (the `EXPECT` array + a new `gate_step`)
- Modify: `.github/workflows/ci.yml` (add the matching step + a pgvector service/Docker)
- Modify (if needed): `package.json` (a `test:pgvector` script running only the container-backed files)

**Interfaces:**
- Produces: a named gate step "pgvector ANN adapter (testcontainer)" present in BOTH `merge-gate.sh`'s hardcoded `EXPECT` and `ci.yml`, so the no-weakening check (`merge-gate.sh` greps `EXPECT` names in a workflow diff) forbids silently dropping it.

- [ ] **Step 1: Add a `test:pgvector` script**

In root `package.json` scripts: `"test:pgvector": "vitest run packages/state-postgres/test/pgvector-store.*.test.ts packages/state-postgres/test/pgvector-container.smoke.test.ts packages/state-postgres/test/vector-factory.ann.test.ts"`.

- [ ] **Step 2: Add the gate step to `merge-gate.sh`**

Append `"pgvector ANN adapter (testcontainer)"` to the `EXPECT=( … )` array, and add after the last `gate_step`:
```bash
gate_step "pgvector ANN adapter (testcontainer)" "pnpm test:pgvector"
```
(The gate already runs on `env -u GOOGLE_CLOUD_PROJECT`; the testcontainer needs Docker available on the gate runner — the accepted dependency.)

- [ ] **Step 3: Add the matching step to `ci.yml`**

Add a step named exactly `pgvector ANN adapter (testcontainer)` running `pnpm test:pgvector`, on a runner with Docker (GitHub-hosted `ubuntu-latest` has Docker; `testcontainers` pulls `pgvector/pgvector:pg16`). Keep the name byte-identical to the `EXPECT` entry.

- [ ] **Step 4: Verify the no-weakening guard sees it**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm test:pgvector` locally (Docker running) — expect all S1 pgvector tests green. Then confirm `merge-gate.sh`'s `EXPECT` contains the new name (so a future PR deleting the ci.yml step is refused).

- [ ] **Step 5: Commit**

```bash
git add .claude/scripts/merge-gate.sh .github/workflows/ci.yml package.json
git commit -m "ci: run the pgvector ANN adapter testcontainer suite as a merge-gate step"
```

---

## Self-review

**Spec coverage (spec §4):** §4.1 scope → Tasks 2–7 (dark, brute-force default: Task 7); §4.2 VectorPort + vector-only + PgVectorTextQueryUnsupported → Tasks 2,4; §4.3 schema/DDL, dimension-parametric, halfvec>2000, separate vp_ann → Task 2; §4.4 query score = 1-distance, dimension guard on upsert → Tasks 3,4; §4.5 HNSW params/ef_search (recall not asserted in unit) → Tasks 2,4,6; §4.6 contract (sibling, refinement noted) → Task 6; §4.7 VECTOR_ANN selection → Task 7; §4.8 erasure transactional + portability sealed → Task 5 + Global Constraints; §4.9 real-pgvector testcontainer as a merge-gate step → Tasks 1,8. Out-of-scope items (serving, producer, ceilings, batch-embed, model pin, freshness, eval-at-scale, per-tenant, kill) are absent — correct.

**Placeholder scan:** No TBD/TODO. Task 6 Step 1 intentionally throws "wired in Step 3" (the failing-test stub replaced in Step 3) — acceptable as the red state, resolved same task. Docker is a real, accepted dependency, not a placeholder.

**Type consistency:** `PgVectorStore(sql, {dimension, efSearch?})`, `migrate()`, `upsert/query/deleteById/deleteNamespace`, `PgVectorTextQueryUnsupported`, `runVectorPortAnnContract(makeAdapter, dimension)`, `createVectorStore` `kind:"ann"` — consistent across tasks. `colType`/`opclass`/`dimension` used identically in Tasks 2–4.

**Open risk carried to execution:** the pgvector literal/cast details (`$::vector(D)` cast form, `<=>`, `hnsw.ef_search`, `vector_cosine_ops`) are recollection-grade and flagged to re-confirm against the pgvector README at build (Global Constraints); the container tests are the proof.
