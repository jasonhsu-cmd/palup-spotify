import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { InMemoryRuntimeStore, createEnvSecrets, type SecretsPort, type ModelPort, type EmbedRequest, type EmbedResponse } from "@palup/platform-ports";
import { PgVectorStore, type Sql } from "@palup/state-postgres";
import { startPgvectorContainer, PGVECTOR_AVAILABLE } from "@palup/state-postgres/test/helpers/pgvector-container";
import { createMemoryService } from "../src/service.js";
import { subjectNamespace } from "../src/identity.js";
import type { MemoryCtx } from "../src/types.js";
import type { FactDistiller } from "../src/distiller.js";

// semantic-memory-v1, PR3 (READ path), T7 — the HEADLINE pgvector-container proof for the READ side
// (mirrors service-pgvector-recall.test.ts's own T4 WRITE-side proof, in the same package).
//
// THE CLAIM THIS PINS: `remember()` (MEMORY_SEMANTIC_RECALL on, T4/PR2 — already shipped and green) writes
// facts WITH real vectors onto a real pgvector/HNSW engine (`vp_ann`) today. What is IMPOSSIBLE TODAY is the
// READ side this PR adds: `recall(ctx, {queryVector, pin})` still ignores its second argument entirely
// (service.ts's `recall` takes only `(ctx)`) and always does the plain list-all
// `vector.query(ns, {text:"", k:RECALL_LIMIT})` — which, for a text query, scores every record via lexical
// Jaccard over an EMPTY token set (always 0, a tie) and returns them in stable ID order, NOT similarity
// order. So `recalled[0]` today is whichever record happens to sort first by id — not the semantically
// nearest one — and the assertion below (`recalled[0]!.text === DOCUMENT_TEXT`) is RED for that completely
// unambiguous reason, not a container/wiring problem.
//
// Skipped when Docker is unavailable (`PGVECTOR_TESTCONTAINER=off`), exactly like every other
// pgvector-container test in this package.

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

/** A fixed lookup-table embed model — mirrors service-pgvector-recall.test.ts's own fixture exactly, so
 *  the WRITE half of this test is byte-identical in spirit to that file's already-green proof. */
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

const DOCUMENT_TEXT = "prefers fragrance-free products";
const DOCUMENT_VECTOR = [1, 0, 0, 0];
// A DELIBERATELY dissimilar ordinary fact (orthogonal to the document/query direction) — its presence
// proves the pgvector engine really ranked, rather than there being only one candidate to pick from.
const DISSIMILAR_TEXT = "asked about a completely unrelated shipping question";
const DISSIMILAR_VECTOR = [0, 1, 0, 0];
const ALLERGY_TEXT = "shopper has a tree-nut allergy";

describe.skipIf(!PGVECTOR_AVAILABLE)("recall() semantic top-K + floor over a REAL pgvector/HNSW engine (vp_ann)", () => {
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
    "returns the semantically-nearest ordinary fact FIRST, plus every pinned allergy fact — the end-to-end semantic-read proof on the real engine",
    async () => {
      await sql.query("TRUNCATE vp_ann");
      const vector = new PgVectorStore(sql, { dimension: DIMENSION });
      const runtimeStore = new InMemoryRuntimeStore();
      const tenantId = "acme-pgv-recall-read";
      const anonId = "guest-pgv-recall-read";
      const ctx: MemoryCtx = { tenantId, anonId, region: "us", consent1: "in", consent2: "in" };

      const model = tableEmbedModel({
        [DOCUMENT_TEXT]: DOCUMENT_VECTOR,
        [DISSIMILAR_TEXT]: DISSIMILAR_VECTOR,
      });
      const service = createMemoryService({
        vector,
        audit: runtimeStore,
        distiller: distillerReturning(DOCUMENT_TEXT, DISSIMILAR_TEXT, ALLERGY_TEXT),
        model,
        enabled: true,
        secrets: keyedSecrets(tenantId), // the allergy write must not be refused for lack of a key
      });

      const written = await service.remember(ctx, { message: "m", reply: "r" });
      expect(written.written).toContain("ordinary");
      expect(written.written).toContain("special");

      // A query vector NEAR the document vector (cosine ~0.995), deliberately not identical — a genuine
      // nearest-neighbor proof on the real HNSW index, not merely "the exact same vector comes back".
      const nearQuery = [0.995, 0.0998, 0, 0];
      const recalled = await service.recall(ctx, { queryVector: nearQuery, pin: { model: "table-embed", dimension: DIMENSION } });

      expect(recalled[0]?.text).toBe(DOCUMENT_TEXT); // nearest ordinary fact FIRST — never outranked by the
      // dissimilar ordinary fact or by the allergy floor entry, at this small (3-record) corpus size.
      const texts = recalled.map((f) => f.text);
      expect(texts).toContain(ALLERGY_TEXT); // the pinned allergy fact, via the floor
    },
    60_000,
  );
});

// LIVE BUG REPRO (found by an E2E staging smoke test, 2026-08-18): every `/chat` recall turn on the
// pgvector ANN store threw `PgVectorTextQueryUnsupported` for a shopper with NO manifest yet (a brand
// new shopper — the state EVERY shopper starts in) — the `recall()` FALLBACK branch (taken when
// `useSemantic` is false: no manifest / no queryVector / pin mismatch) called
// `deps.vector.query(namespace, { text: "", k: RECALL_LIMIT })`, the pre-PR3 "list everything" idiom.
// `PgVectorStore.query` is vector-query-ONLY (no lexical modality — pgvector has no Jaccard) and throws
// unconditionally when `query.vector` is absent, regardless of whether the namespace has any rows at
// all. PR3's own tests never caught this: the in-memory store tolerates the empty-text list-all, and
// `service-pgvector-recall.test.ts`/this file's own describe above always seed a manifest FIRST (so they
// take the semantic path, never the fallback, on a real pgvector store).
describe.skipIf(!PGVECTOR_AVAILABLE)("recall() fallback list-all is pgvector-safe (LIVE bug repro — the no-manifest-recall-on-pgvector proof)", () => {
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
    "a brand-new shopper — empty namespace, no manifest yet — recall(ctx, {queryVector, pin}) returns [] and does NOT throw PgVectorTextQueryUnsupported",
    async () => {
      await sql.query("TRUNCATE vp_ann");
      const vector = new PgVectorStore(sql, { dimension: DIMENSION });
      const runtimeStore = new InMemoryRuntimeStore();
      const tenantId = "acme-pgv-fallback-empty-1";
      const anonId = "guest-pgv-fallback-empty-1";
      const ctx: MemoryCtx = { tenantId, anonId, region: "us", consent1: "in", consent2: "in" };

      const service = createMemoryService({
        vector,
        audit: runtimeStore,
        distiller: { async distill() { return []; } },
        enabled: true,
      });

      // No `remember()` call ever happened for this subject — zero rows in vp_ann, no manifest for the
      // tenant. `queryVector`/`pin` are supplied (the exact live call shape) but, with no manifest to
      // check the pin against, `useSemantic` is false — this must fall through to a pgvector-safe
      // list-all, NOT the old `query({text:""})` idiom (which threw unconditionally on `PgVectorStore`,
      // independent of whether the namespace had any rows).
      const recalled = await service.recall(ctx, { queryVector: [1, 0, 0, 0], pin: { model: "table-embed", dimension: DIMENSION } });
      expect(recalled).toEqual([]);
    },
    60_000,
  );

  it(
    "a brand-new shopper — empty namespace — recall(ctx) with NO options at all also returns [] and does NOT throw",
    async () => {
      await sql.query("TRUNCATE vp_ann");
      const vector = new PgVectorStore(sql, { dimension: DIMENSION });
      const runtimeStore = new InMemoryRuntimeStore();
      const tenantId = "acme-pgv-fallback-empty-2";
      const anonId = "guest-pgv-fallback-empty-2";
      const ctx: MemoryCtx = { tenantId, anonId, region: "us", consent1: "in", consent2: "in" };

      const service = createMemoryService({
        vector,
        audit: runtimeStore,
        distiller: { async distill() { return []; } },
        enabled: true,
      });

      const recalled = await service.recall(ctx);
      expect(recalled).toEqual([]);
    },
    60_000,
  );

  it(
    "a populated namespace (facts already upserted with real/placeholder vectors) but NO queryVector/pin this turn -> fallback list-all returns every fact, unranked, without throwing",
    async () => {
      await sql.query("TRUNCATE vp_ann");
      const vector = new PgVectorStore(sql, { dimension: DIMENSION });
      const runtimeStore = new InMemoryRuntimeStore();
      const tenantId = "acme-pgv-fallback-populated";
      const anonId = "guest-pgv-fallback-populated";
      const ctx: MemoryCtx = { tenantId, anonId, region: "us", consent1: "in", consent2: "in" };

      const model = tableEmbedModel({ [DOCUMENT_TEXT]: DOCUMENT_VECTOR });
      const service = createMemoryService({
        vector,
        audit: runtimeStore,
        distiller: distillerReturning(DOCUMENT_TEXT, ALLERGY_TEXT),
        model,
        enabled: true,
        secrets: keyedSecrets(tenantId), // the allergy write must not be refused for lack of a key
      });

      const written = await service.remember(ctx, { message: "m", reply: "r" });
      expect(written.written).toContain("ordinary");
      expect(written.written).toContain("special");

      // No queryVector supplied this turn -> `useSemantic` is false regardless of the manifest that DOES
      // now exist -> the fallback list-all must run, and on a real pgvector store must not throw.
      const recalled = await service.recall(ctx);
      const texts = recalled.map((f) => f.text);
      expect(texts).toContain(DOCUMENT_TEXT);
      expect(texts).toContain(ALLERGY_TEXT);
      expect(recalled).toHaveLength(2);
    },
    60_000,
  );
});
