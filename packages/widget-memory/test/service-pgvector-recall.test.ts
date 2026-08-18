import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { InMemoryRuntimeStore, createEnvSecrets, type SecretsPort, type ModelPort, type EmbedRequest, type EmbedResponse } from "@palup/platform-ports";
import { PgVectorStore, type Sql } from "@palup/state-postgres";
import { startPgvectorContainer, PGVECTOR_AVAILABLE } from "@palup/state-postgres/test/helpers/pgvector-container";
import { createMemoryService } from "../src/service.js";
import { subjectNamespace, floorNamespace } from "../src/identity.js";
import type { MemoryCtx } from "../src/types.js";
import type { FactDistiller } from "../src/distiller.js";

// semantic-memory-v1, PR2 (write path), T4 — the HEADLINE pgvector-container proof.
//
// THE CLAIM THIS PINS: writing memory facts via `remember()` (MEMORY_SEMANTIC_RECALL on) against a REAL
// pgvector/HNSW engine (`vp_ann`) is IMPOSSIBLE TODAY — `PgVectorStore.upsert` (state-postgres/src/
// pgvector-store.ts:76-80) throws fail-closed on any record missing a dimension-matched `.vector`, and
// `remember()` today (before this PR's embed integration) never stamps one. So the very first assertion
// below (`resolves.not.toThrow()`) is expected to be RED for a completely unambiguous reason: a real
// PgVectorStore error, "must carry a vector of dimension 4 (got none) — refusing to store (fail closed)".
//
// Everything downstream of that (real vector-query recall) is the actual "write AND recall by vector on
// vp_ann" proof the task asks for — it cannot even be reached until the write succeeds.
//
// Mirrors the existing pgvector-container test in this package (memory-pgvector-scale.test.ts) for
// container lifecycle/import shape; skipped when Docker is unavailable (`PGVECTOR_TESTCONTAINER=off`).

const SEMANTIC_FLAG = "MEMORY_SEMANTIC_RECALL";
const DIMENSION = 4;

beforeEach(() => {
  process.env[SEMANTIC_FLAG] = "true";
});
afterEach(() => {
  delete process.env[SEMANTIC_FLAG];
});

function keyedSecrets(...tenantIds: string[]): SecretsPort {
  const byTenant: Record<string, Record<string, string>> = {};
  for (const t of tenantIds) byTenant[t] = { MEMORY_ENCRYPTION_KEY: `test-key-for-${t}` };
  return createEnvSecrets(JSON.stringify(byTenant));
}

/** A fixed lookup-table embed model — the ordinary fact's document vector is chosen so a query vector
 *  the test constructs by hand is unambiguously "near" it (high cosine) and unambiguously far from an
 *  orthogonal "health query" direction. No claim is made about real embedding quality (see every other
 *  fake-embedder note in this package) — only about the WIRING: write, then recall by vector, on the
 *  real engine. */
function tableEmbedModel(table: Record<string, number[]>): ModelPort {
  return {
    async complete() {
      throw new Error("tableEmbedModel: complete() should never be called — this test injects `distiller` directly");
    },
    async embed(req: EmbedRequest): Promise<EmbedResponse> {
      const vectors = req.texts.map((t) => {
        const v = table[t];
        if (!v) throw new Error(`tableEmbedModel: no fixture vector for text: ${JSON.stringify(t)}`);
        return v;
      });
      return { vectors, dimension: DIMENSION, model: "table-embed", purpose: req.purpose };
    },
  };
}

function distillerReturning(...texts: string[]): FactDistiller {
  return { async distill() { return texts.map((text) => ({ text })); } };
}

describe.skipIf(!PGVECTOR_AVAILABLE)("createMemoryService over a REAL pgvector/HNSW engine (vp_ann) — write + recall by vector", () => {
  let sql: Sql;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    ({ sql, stop } = await startPgvectorContainer());
    await new PgVectorStore(sql, { dimension: DIMENSION }).migrate();
  }, 120_000);

  afterAll(async () => {
    await stop?.();
  }, 120_000);

  it(
    "an ordinary fact, written via remember() with semantic recall ON, is retrievable by a NEAR query vector on the real engine — impossible today (vector-less remember() rejected by PgVectorStore.upsert)",
    async () => {
      await sql.query("TRUNCATE vp_ann");
      const vector = new PgVectorStore(sql, { dimension: DIMENSION });
      const runtimeStore = new InMemoryRuntimeStore();
      const tenantId = "acme-pgv-recall";
      const anonId = "guest-pgv-recall";
      const ns = subjectNamespace(tenantId, anonId);

      const DOCUMENT_VECTOR = [1, 0, 0, 0];
      const model = tableEmbedModel({ "prefers fragrance-free products": DOCUMENT_VECTOR });
      const service = createMemoryService({
        vector,
        audit: runtimeStore,
        distiller: distillerReturning("prefers fragrance-free products"),
        model,
        enabled: true,
      });
      const ctx: MemoryCtx = { tenantId, anonId, region: "us", consent1: "in", consent2: "unknown" };

      // THE HEADLINE ASSERTION — today this REJECTS with PgVectorStore's own fail-closed error, because
      // remember() produces a vector-less record and PgVectorStore.upsert refuses to store it.
      await expect(service.remember(ctx, { message: "m", reply: "r" })).resolves.toEqual({ written: ["ordinary"] });

      // A query vector NEAR the document vector (cosine ~0.995) — deliberately not identical, so this is
      // a genuine nearest-neighbor proof, not merely "the exact same vector comes back".
      const nearQuery = [0.995, 0.0998, 0, 0];
      const matches = await vector.query(ns, { vector: nearQuery, k: 1 });
      expect(matches).toHaveLength(1);
      expect(matches[0]!.score).toBeGreaterThan(0.9);
      expect((matches[0]!.metadata as { text?: string }).text).toBe("prefers fragrance-free products");
    },
    60_000,
  );

  it(
    "a special fact is retrievable by `list` (the floor) even though its placeholder vector must never rank near a health-flavored query",
    async () => {
      await sql.query("TRUNCATE vp_ann");
      const vector = new PgVectorStore(sql, { dimension: DIMENSION });
      const runtimeStore = new InMemoryRuntimeStore();
      const tenantId = "acme-pgv-special-floor";
      const anonId = "guest-pgv-special-floor";
      const ns = subjectNamespace(tenantId, anonId);

      const DOCUMENT_VECTOR = [1, 0, 0, 0];
      const model = tableEmbedModel({ "prefers fragrance-free products": DOCUMENT_VECTOR });
      const service = createMemoryService({
        vector,
        audit: runtimeStore,
        distiller: distillerReturning("prefers fragrance-free products", "shopper has a tree-nut allergy"),
        model,
        enabled: true,
        secrets: keyedSecrets(tenantId), // the special write must not be refused for lack of a key
      });
      const ctx: MemoryCtx = { tenantId, anonId, region: "us", consent1: "in", consent2: "in" };

      const result = await service.remember(ctx, { message: "m", reply: "r" });
      expect(result.written).toContain("ordinary");
      expect(result.written).toContain("special");

      // #125 — the special-category record now lives in the dedicated per-subject FLOOR namespace, not
      // the main subject namespace: `list` (a plain keyset scan, no vector op at all) against EACH
      // namespace sees exactly the record that belongs there, regardless of what either one's vector
      // looks like.
      const listed = await vector.list(ns, { limit: 10 });
      expect(listed).toHaveLength(1);
      expect((listed[0]!.metadata as { class?: string }).class).toBe("ordinary");

      const floorListed = await vector.list(floorNamespace(tenantId, anonId), { limit: 10 });
      expect(floorListed).toHaveLength(1);
      expect((floorListed[0]!.metadata as { class?: string }).class).toBe("special");

      // A query vector aimed squarely at the ORDINARY fact's real content — the special placeholder
      // (content-independent by construction — T4's whole point is it is NEVER derived from embedding
      // the health text) must not outrank a real, content-derived embedding for a query aimed at that
      // content: the ordinary fact must come back #1.
      const alignedWithOrdinary = [0.995, 0.0998, 0, 0];
      const top = await vector.query(ns, { vector: alignedWithOrdinary, k: 1 });
      expect(top).toHaveLength(1);
      expect((top[0]!.metadata as { class?: string }).class).toBe("ordinary");
    },
    60_000,
  );

  it(
    "#125 real-pgvector RECALL parity: a special fact written to the floor namespace is surfaced by recall() over PgVectorStore, matching the in-memory floor behavior",
    async () => {
      await sql.query("TRUNCATE vp_ann");
      const vector = new PgVectorStore(sql, { dimension: DIMENSION });
      const runtimeStore = new InMemoryRuntimeStore();
      const tenantId = "acme-pgv-floor-recall";
      const anonId = "guest-pgv-floor-recall";
      const ns = subjectNamespace(tenantId, anonId);

      const DOCUMENT_VECTOR = [1, 0, 0, 0];
      const model = tableEmbedModel({ "prefers fragrance-free products": DOCUMENT_VECTOR });
      const service = createMemoryService({
        vector,
        audit: runtimeStore,
        distiller: distillerReturning("prefers fragrance-free products", "shopper has a tree-nut allergy"),
        model,
        enabled: true,
        secrets: keyedSecrets(tenantId), // the special write must not be refused for lack of a key
      });
      const ctx: MemoryCtx = { tenantId, anonId, region: "us", consent1: "in", consent2: "in" };

      const result = await service.remember(ctx, { message: "m", reply: "r" });
      expect(result.written).toContain("ordinary");
      expect(result.written).toContain("special");

      // Confirms the WRITE landed in the dedicated floor namespace on the real engine (same proof as the
      // sibling test above), before exercising the actual READ path this test is about.
      expect(await vector.list(floorNamespace(tenantId, anonId), { limit: 10 })).toHaveLength(1);

      // THE PARITY CLAIM: recall() — no queryVector/pin supplied, so this exercises the pgvector-safe
      // list-all fallback branch (service.ts) that unions the main namespace with `enumerateFloor` over
      // `floorNs` — must surface BOTH facts against the REAL PgVectorStore, exactly as it already does
      // against the in-memory adapter (service-recall tests elsewhere in this package).
      const recalled = await service.recall(ctx);
      const texts = recalled.map((f) => f.text);
      expect(texts).toContain("prefers fragrance-free products");
      expect(texts).toContain("shopper has a tree-nut allergy"); // the floor row — served, not silently dropped
    },
    60_000,
  );
});
