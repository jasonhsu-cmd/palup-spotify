import { randomUUID } from "node:crypto";
import { createInMemoryVectorStore, InMemoryRuntimeStore, createEnvSecrets } from "@palup/platform-ports";
import type { SecretsPort, ModelPort, EmbedRequest, EmbedResponse } from "@palup/platform-ports";
import { createMemoryService } from "./service.js";
import { subjectNamespace } from "./identity.js";
import type { FactDistiller } from "./distiller.js";
import type { MemoryCtx, RecalledFact } from "./types.js";

// semantic-memory-v1 (PR4/T10) — the retrieval-QUALITY eval harness for MEMORY_SEMANTIC_RECALL's recall()
// path. Mirrors packages/widget-backend/src/retrieval-eval.ts (CATALOG_RETRIEVAL's own eval harness) as
// closely as the two domains allow:
//   - Deterministic, offline, table-lookup embed model — NEVER real Vertex (see `tableEmbedModel` below).
//     Every run in this file/its CLI/its test must be invoked with `env -u GOOGLE_CLOUD_PROJECT` (never set
//     it) — nothing here reads GOOGLE_CLOUD_PROJECT or touches @palup/model-vertex at all.
//   - Built through the REAL `createMemoryService()` — `remember()` to seed, `recall()` to read — never a
//     reimplementation of ranking/floor logic. This proves the actual serving-path wiring, exactly like
//     retrieval-eval.ts's `buildIndexedRetriever` proves catalog's.
//   - Grades deterministically (recall@1 / recall@k), reusing retrieval-eval.ts's `RetrievalCase` shape
//     (`topId`≈`expectTop`, `oneOf`≈`relevantInTopK`) — see `gradeRelevanceCase` below.
//   - ISOLATED EVAL TENANT discipline (retrieval-eval.ts / shadow-retrieval.ts's own clobber guard): every
//     suite here constructs its OWN fresh in-memory VectorPort + RuntimeStatePort and a tenant id prefixed
//     `memory-recall-eval-*` — it never touches a real serving tenant's store, and (unlike catalog
//     retrieval, which can be pointed at a real Cloud SQL instance via VECTOR_ANN=true) there is no
//     durable-store wiring here AT ALL, so there is no clobber surface to guard against in the first place.
//
// ONE STRUCTURAL DIFFERENCE FROM retrieval-eval.ts, called out here rather than silently glossed over:
// `RetrievedProduct` carries a stable `productId`; `RecalledFact` (types.ts) carries only `{text, class,
// disposition}` — recall() has no id concept at all (a fact is prompt content, not a keyed lookup result).
// So every fixture fact's `text` IS its own identity for grading purposes: fixture texts must be unique
// within a corpus, and "recall@1"/"recall@k" here mean "the expected fact's TEXT appears at the expected
// rank position", recovered via a text->id lookup table for readability. This is not a workaround; it is
// what the real serving contract exposes to a caller.

export const EVAL_EMBED_MODEL_ID = "memory-recall-eval-table-embed";

/** Deterministic, offline, text->vector lookup embed model. Throws on an unmapped text — a fixture gap
 *  must fail loudly, never silently embed a zero/garbage vector. Mirrors the `tableEmbedModel` helper
 *  already proven out in service-recall-semantic.test.ts / service-dedup.test.ts, exported here so the
 *  eval harness, its CLI, and its own tests share ONE implementation rather than three drifting copies. */
export function tableEmbedModel(table: Record<string, number[]>, modelId = EVAL_EMBED_MODEL_ID): ModelPort {
  return {
    async complete() {
      throw new Error("memory-recall-eval tableEmbedModel: complete() should never be called — these evals inject `distiller` directly");
    },
    async embed(req: EmbedRequest): Promise<EmbedResponse> {
      const vectors = req.texts.map((t) => {
        const v = table[t];
        if (!v) throw new Error(`memory-recall-eval tableEmbedModel: no fixture vector for text: ${JSON.stringify(t)}`);
        return v;
      });
      const dim = vectors[0]?.length ?? 0;
      return { vectors, dimension: dim, model: modelId, purpose: req.purpose };
    },
  };
}

/** A FactDistiller that returns each of `texts` as its own candidate, unchanged — the same test seam
 *  every existing widget-memory unit test uses to bypass a real (governed, separately-evaled) extractor. */
export function distillerReturning(...texts: string[]): FactDistiller {
  return { async distill() { return texts.map((text) => ({ text })); } };
}

/** An isolated eval-only tenant/subject pair — never a real serving tenant id, and never reused across
 *  runs (random subject suffix) so two concurrent CI runs of this file can never collide even if a future
 *  change points any of this at a shared durable store. Today every suite below constructs its OWN fresh
 *  in-memory stores, so this is defense-in-depth documentation more than a live requirement — but it is
 *  the same discipline retrieval-eval.ts's `buildIndexedRetriever` enforces structurally, kept here so a
 *  future durable-store variant of this harness inherits the isolation by construction, not by convention. */
function isolatedSubject(suffix: string): { tenantId: string; anonId: string } {
  return { tenantId: `memory-recall-eval-${suffix}`, anonId: `subject-${randomUUID()}` };
}

function keyedSecrets(tenantId: string): SecretsPort {
  return createEnvSecrets(JSON.stringify({ [tenantId]: { MEMORY_ENCRYPTION_KEY: `memory-recall-eval-key-${tenantId}` } }));
}

/** Fresh, temporary env-var scopes for the two knobs `remember()`/`recall()` read live
 *  (`MEMORY_SEMANTIC_RECALL`, `MEMORY_RECALL_TOP_K`) — set/restore around one async block so a suite can
 *  never leak its env mutation into a sibling suite or the caller's own process env, mirroring every
 *  existing widget-memory test's own beforeEach/afterEach discipline. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prior = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

export interface SuiteCaseResult {
  id: string;
  pass: boolean;
  fails: string[];
}

export interface SuiteResult {
  cases: SuiteCaseResult[];
  passed: number;
  total: number;
  /** Pass rate 0..100, or `null` when NOTHING was measured (zero cases) — suites.ts's own "an absent
   *  measurement is not a pass" discipline (packages/eval/src/suites.ts:16-33), deliberately NOT
   *  eval-retrieval.ts's own `cases.length ? … : 1` vacuous-pass fallback. See this file's CLI
   *  (eval-memory-recall.ts) for how `null`/empty BLOCKS rather than silently passing. */
  score: number | null;
  /** `true` iff this suite must BLOCK promotion: any case failed, OR (score === null) nothing was
   *  measured at all. Never `false` merely because the case count happens to be zero. */
  blocked: boolean;
}

function summarize(cases: SuiteCaseResult[]): SuiteResult {
  const total = cases.length;
  const passed = cases.filter((c) => c.pass).length;
  const score = total === 0 ? null : (passed * 100) / total;
  return { cases, passed, total, score, blocked: total === 0 || passed !== total };
}

// ============================================================================================
// Suite 1 — recall@k RELEVANCE
// ============================================================================================

export interface RelevanceFactFixture {
  /** Fixture-only identifier for readable case authoring; NEVER persisted (recall() has no id — see this
   *  file's header note). Must correspond 1:1 with a unique `text`. */
  id: string;
  text: string;
  vector: number[];
}

export interface RelevanceCase {
  id: string;
  query: string;
  queryVector: number[];
  /** Overrides the corpus-level `k` for this one case (mirrors RetrievalCase's own per-case `k`). Set
   *  fresh via MEMORY_RECALL_TOP_K immediately before this case's recall() call — the env var is read
   *  live on every call (service.ts `recallTopK()`), so a per-case override is honest, not simulated. */
  k?: number;
  /** The fixture fact id that MUST be recall@1 (rank position 0) — mirrors RetrievalCase.expectTop. */
  topId?: string;
  /** At least one of these fixture fact ids must appear anywhere in the recalled set — recall@k, mirrors
   *  RetrievalCase.relevantInTopK. */
  oneOf?: string[];
}

export interface RelevanceFixtureCorpus {
  facts: RelevanceFactFixture[];
  cases: RelevanceCase[];
  /** Default MEMORY_RECALL_TOP_K for a case with no per-case `k` — mirrors retrieval's own `_meta.k`.
   *  UN-TUNED, same discipline as service.ts's own `recallTopK()` default (16) / `DEFAULT_CATALOG_RETRIEVAL_K`:
   *  a bound picked so this hand-authored, unambiguous fixture has real work to do, not a measured quality
   *  bar. What this suite's 100%-pass bar enforces is "the wiring ranks correctly at whatever K is
   *  configured" — the K value itself stays eval-gated/un-tuned exactly like the product default. */
  k: number;
}

/**
 * S4-style hand-authored corpus (widget-backend/src/retrieval-eval.ts's own `generateScaleCorpusAndCases`
 * pattern, narrowed to memory's domain): four topic clusters, each holding two facts at a controlled,
 * exact cosine similarity to each other (1.0 / ~0.999 / ~0.997 — see the per-cluster comments), and zero
 * cosine to every OTHER cluster (orthogonal one-hot subspaces, index-padded so cross-cluster dot products
 * are always exactly 0). Two cases per cluster: one recall@1 case (query == that cluster's own vector
 * exactly) and, for the first two clusters, an ADDITIONAL recall@k case whose query sits nearer the
 * cluster's SECOND fact — proving both facts rank into a k=2 slice, not just "the corpus round-trips".
 */
const CLUSTER_DIM = 10;
function oneHot(dim: number, i: number): number[] {
  const v = new Array<number>(dim).fill(0);
  v[i] = 1;
  return v;
}
// A small, EXACT-angle offset within a 2D subspace — cos(2°)≈0.99939, cos(4°)≈0.99756. Used to give the
// "second fact" in a cluster a controlled, non-trivial (not 0, not 1) similarity to the cluster's own
// query vector, so the recall@k cases are genuinely testing ranking, not a coincidental tie.
function angledInPlane(dim: number, dimA: number, dimB: number, degrees: number): number[] {
  const v = new Array<number>(dim).fill(0);
  const rad = (degrees * Math.PI) / 180;
  v[dimA] = Math.cos(rad);
  v[dimB] = Math.sin(rad);
  return v;
}

const F_EARBUDS_1 = { id: "f-earbuds-1", text: "prefers wireless earbuds over wired headphones", vector: oneHot(CLUSTER_DIM, 0) };
const F_EARBUDS_2 = {
  id: "f-earbuds-2",
  text: "wants noise-cancelling over-ear headphones for long flights",
  vector: angledInPlane(CLUSTER_DIM, 0, 1, 2), // cos(2°) to F_EARBUDS_1's vector
};
const F_RUNNING_1 = { id: "f-running-1", text: "loves running shoes with extra heel cushioning", vector: oneHot(CLUSTER_DIM, 2) };
const F_RUNNING_2 = {
  id: "f-running-2",
  text: "shops for trail running shoes with aggressive grip",
  vector: angledInPlane(CLUSTER_DIM, 2, 3, 4),
};
const F_SKINCARE_1 = { id: "f-skincare-1", text: "vegan skincare only, no animal-derived ingredients", vector: oneHot(CLUSTER_DIM, 4) };
const F_SKINCARE_2 = { id: "f-skincare-2", text: "fragrance-free skincare due to a sensitive nose", vector: oneHot(CLUSTER_DIM, 5) };
const F_BUDGET_1 = { id: "f-budget-1", text: "budget-conscious, always looks for sales and discounts", vector: oneHot(CLUSTER_DIM, 6) };
const F_BUDGET_2 = { id: "f-budget-2", text: "prefers premium and luxury brands over cheap options", vector: oneHot(CLUSTER_DIM, 7) };

export const RELEVANCE_FIXTURE: RelevanceFixtureCorpus = {
  facts: [F_EARBUDS_1, F_EARBUDS_2, F_RUNNING_1, F_RUNNING_2, F_SKINCARE_1, F_SKINCARE_2, F_BUDGET_1, F_BUDGET_2],
  k: 2,
  cases: [
    { id: "earbuds-recall@1", query: "recommend wireless earbuds", queryVector: F_EARBUDS_1.vector, topId: F_EARBUDS_1.id },
    {
      id: "earbuds-recall@k",
      query: "noise-cancelling over-ear headphones for a flight",
      queryVector: F_EARBUDS_2.vector,
      k: 2,
      topId: F_EARBUDS_2.id,
      oneOf: [F_EARBUDS_1.id], // the near-but-not-nearest sibling must still rank into k=2
    },
    { id: "running-recall@1", query: "running shoes with cushioning", queryVector: F_RUNNING_1.vector, topId: F_RUNNING_1.id },
    {
      id: "running-recall@k",
      query: "trail running shoes with grip",
      queryVector: F_RUNNING_2.vector,
      k: 2,
      topId: F_RUNNING_2.id,
      oneOf: [F_RUNNING_1.id],
    },
    { id: "skincare-vegan", query: "vegan skincare", queryVector: F_SKINCARE_1.vector, topId: F_SKINCARE_1.id },
    { id: "skincare-fragrance-free", query: "fragrance-free skincare", queryVector: F_SKINCARE_2.vector, topId: F_SKINCARE_2.id },
    { id: "budget-conscious", query: "cheap products on sale", queryVector: F_BUDGET_1.vector, topId: F_BUDGET_1.id },
    { id: "budget-premium", query: "luxury premium brand only", queryVector: F_BUDGET_2.vector, topId: F_BUDGET_2.id },
  ],
};

/** Deterministic grade of one relevance case — byte-for-byte the same shape as
 *  widget-backend/src/retrieval-eval.ts `gradeRetrieval` (`topId`≈`expectTop`, `oneOf`≈`relevantInTopK`),
 *  operating on fixture ids already recovered from `RecalledFact.text` by the caller. */
export function gradeRelevanceCase(c: RelevanceCase, recalledIds: string[]): { pass: boolean; fails: string[] } {
  const fails: string[] = [];
  if (c.topId && recalledIds[0] !== c.topId) {
    fails.push(`expected top=${c.topId}, got ${recalledIds[0] ?? "(none)"} (recalled: [${recalledIds.join(", ")}])`);
  }
  if (c.oneOf && !c.oneOf.some((id) => recalledIds.includes(id))) {
    fails.push(`no relevant fact (${c.oneOf.join("/")}) recalled: [${recalledIds.join(", ")}]`);
  }
  return { pass: fails.length === 0, fails };
}

/** Runs the relevance suite through the REAL `createMemoryService()` — one `remember()` seeding call,
 *  then one `recall({queryVector, pin})` per case. Zero cases ⇒ `score: null`, `blocked: true` (never a
 *  vacuous pass — see `summarize`). */
export async function runRelevanceEval(fixture: RelevanceFixtureCorpus = RELEVANCE_FIXTURE): Promise<SuiteResult> {
  if (fixture.cases.length === 0) return summarize([]);

  const { tenantId, anonId } = isolatedSubject("relevance");
  const vector = createInMemoryVectorStore();
  const audit = new InMemoryRuntimeStore();
  const table: Record<string, number[]> = {};
  const idByText = new Map<string, string>();
  for (const f of fixture.facts) {
    table[f.text] = f.vector;
    idByText.set(f.text, f.id);
  }
  const model = tableEmbedModel(table);
  const service = createMemoryService({
    vector,
    audit,
    model,
    enabled: true,
    distiller: distillerReturning(...fixture.facts.map((f) => f.text)),
  });
  const ctx: MemoryCtx = { tenantId, anonId, region: "us", consent1: "in", consent2: "in" };

  return withEnv({ MEMORY_SEMANTIC_RECALL: "true" }, async () => {
    const written = await service.remember(ctx, { message: "eval-seed", reply: "eval-seed" });
    if (written.written.length !== fixture.facts.length) {
      throw new Error(
        `memory-recall-eval relevance fixture drift: expected ${fixture.facts.length} facts to be written, ` +
          `wrote ${written.written.length} — a fixture text likely classified as special, or was refused`,
      );
    }

    const results: SuiteCaseResult[] = [];
    for (const c of fixture.cases) {
      const recalled = await withEnv({ MEMORY_RECALL_TOP_K: String(c.k ?? fixture.k) }, () =>
        service.recall(ctx, { queryVector: c.queryVector, pin: { model: EVAL_EMBED_MODEL_ID, dimension: c.queryVector.length } }),
      );
      const recalledIds = recalled.map((f: RecalledFact) => idByText.get(f.text) ?? `UNKNOWN-FIXTURE-TEXT:${f.text}`);
      results.push({ id: c.id, ...gradeRelevanceCase(c, recalledIds) });
    }
    return summarize(results);
  });
}

// ============================================================================================
// Suite 2 — SAFETY FLOOR
// ============================================================================================

const SAFETY_DIM = 8;

/**
 * Case 1 — a pinned special/mustRecall allergy fact is ALWAYS recalled, even against a query that shares
 * no direction with anything seeded (the load-bearing safety assertion — mirrors the PR3 safety-floor
 * fix, service.ts `isSafetyFloorRow`). `consent2Override` is a TEST SEAM (default "in"): passing "out"/
 * "unknown" proves this case genuinely exercises the write-time consent gate rather than vacuously
 * passing regardless of input — see memory-recall-eval.test.ts's own regression-lock test.
 */
export async function runSafetyFloorOrthogonalQueryCase(consent2Override: MemoryCtx["consent2"] = "in"): Promise<SuiteCaseResult> {
  const id = "safety-floor-mustrecall-survives-orthogonal-query";
  const { tenantId, anonId } = isolatedSubject("safety-orthogonal");
  const vector = createInMemoryVectorStore();
  const audit = new InMemoryRuntimeStore();
  const NEAR_TEXT = "likes minimalist stainless-steel watch faces";
  const ALLERGY_TEXT = "shopper has a severe shellfish allergy";
  const nearVector = oneHot(SAFETY_DIM, 0);
  const queryVector = oneHot(SAFETY_DIM, 1); // shares no direction with the ordinary fact above
  const model = tableEmbedModel({ [NEAR_TEXT]: nearVector });
  const service = createMemoryService({
    vector,
    audit,
    model,
    enabled: true,
    distiller: distillerReturning(NEAR_TEXT, ALLERGY_TEXT),
    secrets: keyedSecrets(tenantId),
  });
  const ctx: MemoryCtx = { tenantId, anonId, region: "us", consent1: "in", consent2: consent2Override };

  return withEnv({ MEMORY_SEMANTIC_RECALL: "true" }, async () => {
    const written = await service.remember(ctx, { message: "m", reply: "r" });
    const fails: string[] = [];
    if (consent2Override === "in" && !written.written.includes("special")) {
      fails.push("fixture did not classify the allergy fact as special — fixture drift, not a recall bug");
    }
    const recalled = await service.recall(ctx, { queryVector, pin: { model: EVAL_EMBED_MODEL_ID, dimension: SAFETY_DIM } });
    const texts = recalled.map((f) => f.text);
    if (!texts.includes(ALLERGY_TEXT)) {
      fails.push(`pinned safety fact missing from recall against an orthogonal query — got: [${texts.join(", ")}]`);
    } else {
      const specialFact = recalled.find((f) => f.text === ALLERGY_TEXT);
      if (specialFact?.class !== "special") fails.push('recalled safety fact lost its "special" class');
    }
    return { id, pass: fails.length === 0, fails };
  });
}

/**
 * Case 2 — the flag-off-then-on migration case: a `class:"special"` fact written while
 * MEMORY_SEMANTIC_RECALL was OFF (so it carries no `mustRecall` stamp and no `.vector` at all — byte-
 * identical to every special fact this package wrote before T4/T5 ever existed) must STILL surface once
 * the flag is later flipped on for a subsequent visit. Built entirely through remember()/recall(): step 1
 * writes with the flag genuinely unset; step 2 flips it on and writes an ORDINARY fact (which is what
 * pins this tenant's memory-corpus manifest — recall()'s semantic path refuses to rank without one); step
 * 3 recalls and asserts the untouched legacy fact is still present via the floor.
 */
export async function runSafetyFloorLegacyNoMustRecallCase(): Promise<SuiteCaseResult> {
  const id = "safety-floor-legacy-special-no-mustrecall-flag-off-then-on";
  const { tenantId, anonId } = isolatedSubject("safety-legacy");
  const vector = createInMemoryVectorStore();
  const audit = new InMemoryRuntimeStore();
  const LEGACY_ALLERGY_TEXT = "shopper is allergic to tree nuts (written before semantic recall existed)";
  const ORDINARY_TEXT = "likes bold, saturated colors in home decor";
  const ordinaryVector = oneHot(SAFETY_DIM, 2);
  const secrets = keyedSecrets(tenantId);
  const ctx: MemoryCtx = { tenantId, anonId, region: "us", consent1: "in", consent2: "in" };

  const legacyWritten = await withEnv({ MEMORY_SEMANTIC_RECALL: undefined }, () => {
    const legacyService = createMemoryService({ vector, audit, enabled: true, distiller: distillerReturning(LEGACY_ALLERGY_TEXT), secrets });
    return legacyService.remember(ctx, { message: "m1", reply: "r1" });
  });

  return withEnv({ MEMORY_SEMANTIC_RECALL: "true" }, async () => {
    const model = tableEmbedModel({ [ORDINARY_TEXT]: ordinaryVector });
    const service = createMemoryService({ vector, audit, model, enabled: true, distiller: distillerReturning(ORDINARY_TEXT), secrets });
    await service.remember(ctx, { message: "m2", reply: "r2" });

    const recalled = await service.recall(ctx, { queryVector: oneHot(SAFETY_DIM, 3), pin: { model: EVAL_EMBED_MODEL_ID, dimension: SAFETY_DIM } });
    const texts = recalled.map((f) => f.text);
    const fails: string[] = [];
    if (legacyWritten.written[0] !== "special") fails.push("fixture did not write the legacy fact as special — fixture drift, not a recall bug");
    if (!texts.includes(LEGACY_ALLERGY_TEXT)) {
      fails.push(`legacy class:"special" fact (no mustRecall, written flag-off) missing from recall after flag flip-on — got: [${texts.join(", ")}]`);
    }
    return { id, pass: fails.length === 0, fails };
  });
}

/** Runs both safety-floor cases. Unlike the relevance/dedup suites this is a FIXED set of governance
 *  invariants (not a variable-size corpus a fixture author could accidentally empty out), so it always
 *  reports exactly 2 cases — never `null`. */
export async function runSafetyFloorEval(): Promise<SuiteResult> {
  const results = [await runSafetyFloorOrthogonalQueryCase(), await runSafetyFloorLegacyNoMustRecallCase()];
  return summarize(results);
}

// ============================================================================================
// Suite 3 — DEDUP QUALITY
// ============================================================================================

export interface DedupFactFixture {
  text: string;
  vector: number[];
}

export interface DedupFixtureCorpus {
  /** N near-identical paraphrases of ONE preference — MUST collapse to exactly one stored record. */
  paraphrases: DedupFactFixture[];
  /** M genuinely-distinct facts — MUST all be retained as separate records. */
  distinct: DedupFactFixture[];
}

const DEDUP_DIM = 5;
/** Three paraphrases within a 2° arc of each other in the same 2D subspace — every PAIRWISE cosine is
 *  cos(≤4°) ≈ 0.9976..0.9994, comfortably above the 0.95 default `MEMORY_DEDUP_THRESHOLD` regardless of
 *  write order (T5 upsert-in-place replaces the stored vector with the NEWEST candidate's each time, so a
 *  single-plane, small-arc design keeps every later paraphrase close to whichever one is currently
 *  stored — not just close to the first). */
export const DEDUP_FIXTURE: DedupFixtureCorpus = {
  paraphrases: [
    { text: "prefers fragrance-free products", vector: angledInPlane(DEDUP_DIM, 0, 1, 0) },
    { text: "prefers fragrance free (no added fragrance)", vector: angledInPlane(DEDUP_DIM, 0, 1, 2) },
    { text: "wants products without any added fragrance at all", vector: angledInPlane(DEDUP_DIM, 0, 1, 4) },
  ],
  distinct: [
    { text: "loves hiking in national parks", vector: oneHot(DEDUP_DIM, 2) },
    { text: "shops mainly for kitchen gadgets", vector: oneHot(DEDUP_DIM, 3) },
    { text: "prefers loose-fit clothing over slim-fit", vector: oneHot(DEDUP_DIM, 4) },
  ],
};

/** Runs the dedup suite through the REAL `createMemoryService()` — one `remember()` call PER text (a
 *  separate "visit"), all against the SAME subject's vector store, exactly mirroring
 *  service-dedup.test.ts's own multi-visit structure. Grades by inspecting the FINAL stored record set
 *  (`vector.list`), matching plaintext `metadata.text` back to each fixture group (no encryption key is
 *  configured — these are ordinary facts, so they take the ordinary best-effort plaintext path). */
export async function runDedupEval(fixture: DedupFixtureCorpus = DEDUP_FIXTURE): Promise<SuiteResult> {
  if (fixture.paraphrases.length === 0 && fixture.distinct.length === 0) return summarize([]);

  const { tenantId, anonId } = isolatedSubject("dedup");
  const vector = createInMemoryVectorStore();
  const audit = new InMemoryRuntimeStore();
  const table: Record<string, number[]> = {};
  for (const f of [...fixture.paraphrases, ...fixture.distinct]) table[f.text] = f.vector;
  const model = tableEmbedModel(table);
  const ctx: MemoryCtx = { tenantId, anonId, region: "us", consent1: "in", consent2: "unknown" };
  const ns = subjectNamespace(tenantId, anonId);

  return withEnv({ MEMORY_SEMANTIC_RECALL: "true" }, async () => {
    for (const f of [...fixture.paraphrases, ...fixture.distinct]) {
      const service = createMemoryService({ vector, audit, model, enabled: true, distiller: distillerReturning(f.text) });
      await service.remember(ctx, { message: "m", reply: "r" });
    }

    const listed = await vector.list(ns, { limit: 100 });
    const listedTexts = listed.map((r) => (r.metadata as { text?: string } | undefined)?.text).filter((t): t is string => !!t);
    const paraphraseTexts = new Set(fixture.paraphrases.map((f) => f.text));
    const distinctTexts = new Set(fixture.distinct.map((f) => f.text));
    const paraphraseRecords = listedTexts.filter((t) => paraphraseTexts.has(t));
    const distinctRecords = listedTexts.filter((t) => distinctTexts.has(t));
    const unexpected = listedTexts.filter((t) => !paraphraseTexts.has(t) && !distinctTexts.has(t));

    const results: SuiteCaseResult[] = [];
    if (fixture.paraphrases.length > 0) {
      results.push({
        id: "dedup-paraphrases-collapse-to-one",
        pass: paraphraseRecords.length === 1,
        fails:
          paraphraseRecords.length === 1
            ? []
            : [
                `expected exactly 1 stored record among ${fixture.paraphrases.length} near-duplicate paraphrases ` +
                  `(cosine ≥ MEMORY_DEDUP_THRESHOLD), found ${paraphraseRecords.length}: [${paraphraseRecords.join(", ")}]`,
              ],
      });
    }
    if (fixture.distinct.length > 0) {
      results.push({
        id: "dedup-distinct-facts-all-retained",
        pass: distinctRecords.length === fixture.distinct.length,
        fails:
          distinctRecords.length === fixture.distinct.length
            ? []
            : [
                `expected all ${fixture.distinct.length} genuinely-distinct facts (cosine below threshold) retained ` +
                  `as separate records — a too-low threshold silently drops a distinct consented fact — found ` +
                  `${distinctRecords.length}: [${distinctRecords.join(", ")}]`,
              ],
      });
    }
    if (unexpected.length > 0) {
      results.push({ id: "dedup-no-unexpected-records", pass: false, fails: [`unexpected stored record(s) outside either fixture group: [${unexpected.join(", ")}]`] });
    }
    return summarize(results);
  });
}
