import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createInMemoryVectorStore,
  InMemoryRuntimeStore,
  createEnvSecrets,
  type VectorPort,
  type SecretsPort,
  type ModelPort,
  type EmbedRequest,
  type EmbedResponse,
} from "@palup/platform-ports";
import { createMemoryService } from "../src/service.js";
import { subjectNamespace } from "../src/identity.js";
import { writeMemoryManifest } from "../src/manifest.js";
import type { MemoryCtx, RecalledFact } from "../src/types.js";
import type { FactDistiller } from "../src/distiller.js";

// semantic-memory-v1, PR3 (READ path), T7 — recall() gains an options arg:
//   recall(ctx, opts?: { queryVector?: number[]; pin?: { model: string; dimension: number } })
//
// RED TODAY, FOR AN UNAMBIGUOUS REASON: `service.ts`'s `recall` still only takes `(ctx)` and always does
// `vector.query(ns, {text:"", k:RECALL_LIMIT})` — a plain list-all. Every test below that supplies a
// `queryVector` and expects RANKING/EXCLUSION currently fails because the second argument is silently
// ignored at runtime (TypeScript accepts the call — see this file's own `types.ts` widening note below —
// but nothing in `service.ts` reads `opts` yet). The fallback/golden tests at the bottom are the exception:
// they assert TODAY's list-all behavior and should already pass, standing as the "byte-identical when
// inapplicable" baseline PR3 must preserve.
//
// WHAT THIS FILE DOES NOT CLAIM: the fake embedder below is a fully test-controlled lookup table, not a
// real embedding model. It proves the WIRING (which records rank, which are excluded from ranking, which
// always surface via the floor regardless of similarity) — never retrieval quality on real embeddings
// (the eval gate's job). "Near"/"far" here means "cosine similarity to a hand-picked query vector",
// nothing about real semantic meaning.

const SEMANTIC_FLAG = "MEMORY_SEMANTIC_RECALL";
const TOP_K_ENV = "MEMORY_RECALL_TOP_K";
const FLOOR_CAP_ENV = "MEMORY_FLOOR_CAP";

beforeEach(() => {
  delete process.env[SEMANTIC_FLAG];
  delete process.env[TOP_K_ENV];
  delete process.env[FLOOR_CAP_ENV];
});
afterEach(() => {
  delete process.env[SEMANTIC_FLAG];
  delete process.env[TOP_K_ENV];
  delete process.env[FLOOR_CAP_ENV];
});

function keyedSecrets(...tenantIds: string[]): SecretsPort {
  const byTenant: Record<string, Record<string, string>> = {};
  for (const t of tenantIds) byTenant[t] = { MEMORY_ENCRYPTION_KEY: `test-key-for-${t}` };
  return createEnvSecrets(JSON.stringify(byTenant));
}

const DIMENSION = 50;
const PIN = { model: "table-embed-50d", dimension: DIMENSION };

/** A one-hot unit vector at index `i` of length `DIMENSION` — orthogonal (cosine 0) to every OTHER
 *  index, so distinct "far" facts never tie-collapse via T5's write-time cosine dedup (>= 0.95 threshold)
 *  and never accidentally score non-zero against the query used below. */
function basis(i: number): number[] {
  const v = new Array<number>(DIMENSION).fill(0);
  v[i] = 1;
  return v;
}

/** Exact lookup-table embed model — deterministic, offline, no network. Throws on an unmapped text so a
 *  test fixture drift (a text with no fixture vector) fails loudly rather than silently embedding zeros. */
function tableEmbedModel(table: Record<string, number[]>): ModelPort {
  return {
    async complete() {
      throw new Error("tableEmbedModel: complete() should never be called — these tests inject `distiller` directly");
    },
    async embed(req: EmbedRequest): Promise<EmbedResponse> {
      const vectors = req.texts.map((t) => {
        const v = table[t];
        if (!v) throw new Error(`tableEmbedModel: no fixture vector for text: ${JSON.stringify(t)}`);
        return v;
      });
      // Dimension is derived from the ACTUAL fixture vectors (never a hardcoded constant) so a fixture
      // using a narrower dimension than DIMENSION (e.g. the TOP_K test's 2-d vectors) still reports a
      // dimension that matches its own vectors — `remember()` calls `requireEmbedAlignment` on this
      // response and would (correctly) reject a lying dimension.
      const dim = vectors[0]?.length ?? DIMENSION;
      return { vectors, dimension: dim, model: PIN.model, purpose: req.purpose };
    },
  };
}

function distillerReturning(...texts: string[]): FactDistiller {
  return { async distill() { return texts.map((text) => ({ text })); } };
}

const NEAR_TEXT = "likes product family alpha-7"; // deliberately generic — must classify ORDINARY
const QUERY_VECTOR = basis(0); // index 0 — the "near" fact is embedded at the SAME index (cosine 1.0)
const FAR_COUNT = 48;
function farText(i: number): string {
  return `interested in unrelated category z-${i}`;
}

/** Seeds one "near" ordinary fact (cosine ~1.0 to QUERY_VECTOR), FAR_COUNT dissimilar ordinary facts
 *  (cosine 0, each mutually orthogonal so T5 write-time dedup never collapses them), and TWO special
 *  (mustRecall) allergy facts — all via a single `remember()` call. `remember()`'s own T4/T5 machinery
 *  (already shipped, PR2) is reused as-is to stamp `.vector`/`mustRecall` — this file only pins the READ
 *  side of that data. Requires a keyed secrets port so the special writes are not refused for lack of a key.
 */
async function seedFiftyish(tenantId: string, anonId: string) {
  const vector = createInMemoryVectorStore();
  const runtimeStore = new InMemoryRuntimeStore();
  const table: Record<string, number[]> = { [NEAR_TEXT]: basis(0) };
  for (let i = 0; i < FAR_COUNT; i++) table[farText(i)] = basis(2 + i); // dims 2..49 — 48 distinct directions
  const model = tableEmbedModel(table);
  const distiller = distillerReturning(
    NEAR_TEXT,
    ...Array.from({ length: FAR_COUNT }, (_, i) => farText(i)),
    "shopper has a tree-nut allergy",
    "shopper has a shellfish allergy",
  );
  const service = createMemoryService({
    vector,
    audit: runtimeStore,
    distiller,
    model,
    enabled: true,
    secrets: keyedSecrets(tenantId),
  });
  const ctx: MemoryCtx = { tenantId, anonId, region: "us", consent1: "in", consent2: "in" };
  process.env[SEMANTIC_FLAG] = "true";
  const written = await service.remember(ctx, { message: "m", reply: "r" });
  expect(written.written.filter((c) => c === "ordinary")).toHaveLength(FAR_COUNT + 1);
  expect(written.written.filter((c) => c === "special")).toHaveLength(2);
  return { vector, runtimeStore, service, ctx };
}

describe("T7 — recall() semantic top-K + safety floor (MEMORY_SEMANTIC_RECALL)", () => {
  it("returns the near ordinary fact, excludes the bulk of the 48 dissimilar ordinary facts, AND returns BOTH pinned allergy facts regardless of similarity (the load-bearing safety assertion)", async () => {
    const { service, ctx } = await seedFiftyish("acme-50", "guest-50");
    process.env[TOP_K_ENV] = "5";

    const recalled = await service.recall(ctx, { queryVector: QUERY_VECTOR, pin: PIN });
    const texts = recalled.map((f) => f.text);

    // The near ordinary fact is present...
    expect(texts).toContain(NEAR_TEXT);
    // ...but the 48 dissimilar ordinary facts are NOT all present — the ranked slice is capped, so at
    // most TOP_K-1 of them could possibly ride along with the near fact, never all 48.
    const farPresent = texts.filter((t) => t.startsWith("interested in unrelated category"));
    expect(farPresent.length).toBeLessThan(FAR_COUNT);

    // BOTH allergy facts surface — via the floor, not because they were "close" to an unrelated query.
    expect(texts).toContain("shopper has a tree-nut allergy");
    expect(texts).toContain("shopper has a shellfish allergy");
    expect(recalled.filter((f) => f.class === "special")).toHaveLength(2);
  });

  it("a mustRecall/special record that would rank #1 by raw similarity is EXCLUDED from the ranked slice — yet still surfaces via the floor", async () => {
    // Deterministic (no RNG): manually seed one ordinary near/far pair via remember(), then hand-craft a
    // special/mustRecall record whose vector is IDENTICAL to the query — the record that would win the
    // ranked slice outright if the floor exclusion did not apply.
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const table: Record<string, number[]> = { [NEAR_TEXT]: basis(0), [farText(0)]: basis(1) };
    const service = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: distillerReturning(NEAR_TEXT, farText(0)),
      model: tableEmbedModel(table),
      enabled: true,
    });
    const tenantId = "acme-floor-exclude";
    const anonId = "guest-floor-exclude";
    const ctx: MemoryCtx = { tenantId, anonId, region: "us", consent1: "in", consent2: "in" };
    process.env[SEMANTIC_FLAG] = "true";
    await service.remember(ctx, { message: "m", reply: "r" });

    const ns = subjectNamespace(tenantId, anonId);
    const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    await vector.upsert(ns, [
      {
        id: "hand-seeded-special-1",
        text: "shopper has a rare contact-dermatitis allergy",
        vector: QUERY_VECTOR, // identical to the query — would rank #1 by cosine alone
        metadata: {
          text: "shopper has a rare contact-dermatitis allergy",
          class: "special",
          mustRecall: true,
          expiresAt: future,
          encrypted: false,
        },
      },
    ]);

    process.env[TOP_K_ENV] = "1"; // only ONE ranked slot — if the special record were ranked, it alone would fill it
    const recalled = await service.recall(ctx, { queryVector: QUERY_VECTOR, pin: PIN });
    const texts = recalled.map((f) => f.text);

    // The floor still surfaces it...
    expect(texts).toContain("shopper has a rare contact-dermatitis allergy");
    // ...but the ranked slot (capped at 1) went to the genuinely-nearest ORDINARY fact, not this record —
    // and the total is exactly 2 (near + floor special), NOT 3: the far ordinary fact (farText(0)) is
    // correctly capped out, proving this isn't merely "everything came back" (list-all, today's baseline,
    // would return all 3 — near + far + special — satisfying only the two `toContain` checks above by
    // accident).
    expect(texts).toContain(NEAR_TEXT);
    expect(recalled).toHaveLength(2);
  });

  it("MEMORY_RECALL_TOP_K caps the ranked (non-floor) set to exactly that many, nearest-first", async () => {
    // Strictly ordered similarities, no ties: factA (cos 1.0) > factB (cos 0.9) > factC (cos 0.5) > factD (cos 0.0).
    const q = [1, 0];
    const a = [1, 0];
    const b = [0.9, Math.sqrt(1 - 0.81)];
    const c = [0.5, Math.sqrt(1 - 0.25)];
    const d = [0, 1];
    const table = { "fact a": a, "fact b": b, "fact c": c, "fact d": d };
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const service = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: distillerReturning("fact a", "fact b", "fact c", "fact d"),
      model: tableEmbedModel(table),
      enabled: true,
    });
    const tenantId = "acme-topk";
    const anonId = "guest-topk";
    const ctx: MemoryCtx = { tenantId, anonId, region: "us", consent1: "in", consent2: "unknown" };
    process.env[SEMANTIC_FLAG] = "true";
    await service.remember(ctx, { message: "m", reply: "r" });

    process.env[TOP_K_ENV] = "2";
    const recalled = await service.recall(ctx, { queryVector: q, pin: { model: PIN.model, dimension: 2 } });
    expect(recalled.map((f) => f.text)).toEqual(["fact a", "fact b"]); // nearest-first, capped at 2
  });
});

describe("T7 — fallback to the pre-PR3 list-all baseline (goldens; must stay byte-identical)", () => {
  it("no queryVector supplied -> byte-identical to calling recall(ctx) with no options at all", async () => {
    const { service, ctx } = await seedFiftyish("acme-fallback-1", "guest-fallback-1");
    const baseline = await service.recall(ctx);
    const noVector = await service.recall(ctx, {});
    expect(noVector).toEqual(baseline);
  });

  it("pin MODEL mismatch -> byte-identical to the list-all baseline (semantic path never trusted)", async () => {
    const { service, ctx } = await seedFiftyish("acme-fallback-2", "guest-fallback-2");
    const baseline = await service.recall(ctx);
    const wrongModel = await service.recall(ctx, { queryVector: QUERY_VECTOR, pin: { model: "some-other-model", dimension: DIMENSION } });
    expect(wrongModel).toEqual(baseline);
  });

  it("pin DIMENSION mismatch -> byte-identical to the list-all baseline", async () => {
    const { service, ctx } = await seedFiftyish("acme-fallback-3", "guest-fallback-3");
    const baseline = await service.recall(ctx);
    const wrongDim = await service.recall(ctx, { queryVector: QUERY_VECTOR, pin: { model: PIN.model, dimension: 999 } });
    expect(wrongDim).toEqual(baseline);
  });

  it("MEMORY_SEMANTIC_RECALL OFF (dark) -> byte-identical to the list-all baseline even with a VALID, matching queryVector+pin", async () => {
    const { vector, runtimeStore, ctx } = await seedFiftyish("acme-fallback-4", "guest-fallback-4");
    delete process.env[SEMANTIC_FLAG];
    const serviceOff = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: { async distill() { return []; } },
      enabled: true,
      semanticRecall: false, // explicit — the double-negative "flag off" case
    });
    const baseline = await serviceOff.recall(ctx);
    const withValidOpts = await serviceOff.recall(ctx, { queryVector: QUERY_VECTOR, pin: PIN });
    expect(withValidOpts).toEqual(baseline);
  });
});

describe("T7 — the ranked+floor UNION still respects existing TTL-on-read + audits", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("an EXPIRED mustRecall/special fact is never served, even via the floor", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const tenantId = "acme-floor-ttl";
    const anonId = "guest-floor-ttl";
    const ns = subjectNamespace(tenantId, anonId);
    const past = new Date(Date.now() - DAY).toISOString();
    await vector.upsert(ns, [
      {
        id: "expired-special-1",
        text: "shopper has an expired-relevance allergy note",
        vector: basis(0),
        metadata: { text: "shopper has an expired-relevance allergy note", class: "special", mustRecall: true, expiresAt: past, encrypted: false },
      },
    ]);
    const service = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: { async distill() { return []; } },
      enabled: true,
      semanticRecall: true,
    });
    const ctx: MemoryCtx = { tenantId, anonId, region: "us", consent1: "in", consent2: "in" };

    const recalled = await service.recall(ctx, { queryVector: basis(0), pin: { model: "x", dimension: DIMENSION } });
    expect(recalled).toEqual([]); // TTL governs the floor exactly like the ranked half
  });

  it("recall's audit count reflects the ranked+floor UNION, and ttl_renew (when it fires) covers both halves", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const tenantId = "acme-union-audit";
    const anonId = "guest-union-audit";
    let nowMs = new Date("2026-01-01T00:00:00Z").getTime();
    const service = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: distillerReturning(NEAR_TEXT, "shopper has a tree-nut allergy"),
      model: tableEmbedModel({ [NEAR_TEXT]: basis(0) }),
      enabled: true,
      clock: () => new Date(nowMs),
      secrets: keyedSecrets(tenantId),
      semanticRecall: true,
    });
    const ctx: MemoryCtx = { tenantId, anonId, region: "us", consent1: "in", consent2: "in" };
    await service.remember(ctx, { message: "m", reply: "r" });

    // Return visit at day 25 (< 30d TTL, > RENEW_MIN_GAP) — both classes should slide.
    nowMs += 25 * DAY;
    const recalled = await service.recall(ctx, { queryVector: basis(0), pin: { model: PIN.model, dimension: DIMENSION } });
    expect(recalled).toHaveLength(2); // one ranked ordinary + one floor special — the UNION

    const log = await runtimeStore.readAudit({ tenantId });
    const recallEvt = log.filter((r) => r.action === "recall").at(-1);
    expect((recallEvt?.decision as { count?: number } | undefined)?.count).toBe(2);
    const renewEvt = log.find((r) => r.action === "ttl_renew");
    expect(renewEvt).toBeDefined();
    expect((renewEvt?.decision as { count?: number } | undefined)?.count).toBe(2); // BOTH halves slid, not just the ranked one
  });
});

// SECURITY-REVIEW REGRESSION LOCK (feat/memory-v1-pr3-semantic-recall, PR #321 — the PR was BLOCKED on
// these two completeness holes; the fixes are in service.ts's `isSafetyFloorRow`/`enumerateFloor`).
describe("T7 — security-review fix: the safety floor must never silently drop a shopper's own safety fact", () => {
  it("HOLE 1 (HIGH): a class:\"special\" row with NO `mustRecall` field (as written before MEMORY_SEMANTIC_RECALL ever existed) still surfaces via the floor, even though its vector is ORTHOGONAL to the query", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const tenantId = "acme-legacy-special";
    const anonId = "guest-legacy-special";
    const service = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: distillerReturning(NEAR_TEXT),
      model: tableEmbedModel({ [NEAR_TEXT]: basis(0) }),
      enabled: true,
    });
    const ctx: MemoryCtx = { tenantId, anonId, region: "us", consent1: "in", consent2: "in" };
    process.env[SEMANTIC_FLAG] = "true";
    // Establishes this tenant's embed pin (the manifest `recall()`'s semantic path requires) via an
    // ordinary write — same setup shape as this file's other hand-seeded tests.
    await service.remember(ctx, { message: "m", reply: "r" });

    // Simulate a special-category fact written BEFORE MEMORY_SEMANTIC_RECALL existed on this tenant:
    // `class: "special"` but deliberately NO `mustRecall` key at all — `mustRecall` is only ever stamped
    // by the flag-gated write path in `remember()`, so a pre-existing special fact never carries it.
    const ns = subjectNamespace(tenantId, anonId);
    const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    await vector.upsert(ns, [
      {
        id: "legacy-special-1",
        text: "shopper is allergic to tree nuts",
        vector: basis(1), // ORTHOGONAL to QUERY_VECTOR (basis(0)) — cosine 0, never ranks in on similarity
        metadata: {
          text: "shopper is allergic to tree nuts",
          class: "special",
          // NOTE: no `mustRecall` field here — this is the exact shape the bug dropped.
          expiresAt: future,
          encrypted: false,
        },
      },
    ]);

    const recalled = await service.recall(ctx, { queryVector: QUERY_VECTOR, pin: PIN });
    const texts = recalled.map((f) => f.text);
    expect(texts).toContain("shopper is allergic to tree nuts");
    expect(recalled.some((f) => f.class === "special")).toBe(true);
  });

  it("HOLE 2 (MEDIUM): a subject with more facts than one MEMORY_FLOOR_CAP page still surfaces a floor fact whose id sorts past the first page — the floor paginates to exhaustion", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const tenantId = "acme-floor-paginate";
    const anonId = "guest-floor-paginate";
    const ns = subjectNamespace(tenantId, anonId);

    // A small cap so a modest fixture (well under the production default of 500) still forces multiple
    // pages. The in-memory store's `list` returns ids in ASCENDING lexicographic order (vector-port.ts),
    // so 12 ordinary rows with ids that sort strictly BEFORE the special row's id will fully occupy the
    // first two pages at cap=5, and the special row (id "zzz-special-1") only turns up on page 3 — dropped
    // entirely by a single-page floor, surfaced only if the floor paginates to exhaustion.
    process.env[FLOOR_CAP_ENV] = "5";
    const ORDINARY_COUNT = 12;
    const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    const ordinaryRows = Array.from({ length: ORDINARY_COUNT }, (_, i) => ({
      id: `row-${String(i).padStart(2, "0")}`, // "row-00".."row-11" — sorts before "zzz-special-1"
      text: `ordinary fact number ${i}`,
      vector: basis(2 + i),
      metadata: { text: `ordinary fact number ${i}`, class: "ordinary" as const, expiresAt: future, encrypted: false },
    }));
    await vector.upsert(ns, ordinaryRows);
    await vector.upsert(ns, [
      {
        id: "zzz-special-1",
        text: "shopper has a severe bee-sting allergy",
        vector: basis(1),
        metadata: {
          text: "shopper has a severe bee-sting allergy",
          class: "special",
          mustRecall: true,
          expiresAt: future,
          encrypted: false,
        },
      },
    ]);
    // Seed the tenant's own embed pin directly (no need to route a real embed call through `remember()`
    // for a test that only exercises floor pagination, not ranking).
    await writeMemoryManifest(runtimeStore, { tenantId }, { model: PIN.model, dimension: DIMENSION, purpose: "document", at: new Date().toISOString() });

    const service = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: { async distill() { return []; } },
      enabled: true,
      semanticRecall: true,
    });
    const ctx: MemoryCtx = { tenantId, anonId, region: "us", consent1: "in", consent2: "in" };

    const recalled = await service.recall(ctx, { queryVector: QUERY_VECTOR, pin: PIN });
    const texts = recalled.map((f) => f.text);
    expect(texts).toContain("shopper has a severe bee-sting allergy");
    expect(recalled.some((f) => f.class === "special")).toBe(true);
  });
});
