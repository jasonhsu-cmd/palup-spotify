import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RELEVANCE_FIXTURE,
  DEDUP_FIXTURE,
  runRelevanceEval,
  runSafetyFloorEval,
  runSafetyFloorOrthogonalQueryCase,
  runSafetyFloorLegacyNoMustRecallCase,
  runDedupEval,
  gradeRelevanceCase,
  EVAL_EMBED_MODEL_ID,
  type RelevanceFixtureCorpus,
  type DedupFixtureCorpus,
} from "../src/memory-recall-eval.js";
import { runMemoryRecallEval } from "../src/eval-memory-recall.js";

// semantic-memory-v1 (PR4/T10) — the eval SUITE'S OWN tests: this file must fail (red) whenever the
// harness's grading genuinely regresses (recall@k drops, a pinned safety fact goes missing, dedup
// mis-collapses), not just when the harness fails to run at all. Every run here uses ONLY the
// deterministic mock embed model in memory-recall-eval.ts — no real Vertex, no GOOGLE_CLOUD_PROJECT read
// anywhere in this file or the modules it imports.
//
// PORT-CONTRACT NOTE: this file does not re-test remember()/recall()'s own port contract (that is
// service-recall-semantic.test.ts / service-dedup.test.ts's job, and those files remain the standing
// regression lock for the underlying mechanisms). This file tests the EVAL HARNESS itself: that it
// measures what it claims to measure, and that "null"/empty never reads as a silent pass.

const ENV_KEYS = ["MEMORY_SEMANTIC_RECALL", "MEMORY_RECALL_TOP_K", "MEMORY_FLOOR_CAP", "MEMORY_DEDUP_THRESHOLD"];

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("memory-recall-eval — Suite 1: recall@k RELEVANCE", () => {
  it("the hand-authored fixture passes 100% — recall@1 (topId) AND recall@k (oneOf) — through the REAL remember()/recall() paths", async () => {
    const result = await runRelevanceEval();
    if (result.cases.some((c) => !c.pass)) {
      // Print the actual failure reasons on a red run, not just "expected true, got false".
      console.error(JSON.stringify(result.cases.filter((c) => !c.pass), null, 2));
    }
    expect(result.total).toBe(RELEVANCE_FIXTURE.cases.length);
    expect(result.score).toBe(100);
    expect(result.blocked).toBe(false);
    expect(result.cases.every((c) => c.pass)).toBe(true);
  });

  it("an EMPTY fixture is UNMEASURED (score: null) and BLOCKS — an absent measurement is never a silent pass", async () => {
    const empty: RelevanceFixtureCorpus = { facts: [], cases: [], k: 2 };
    const result = await runRelevanceEval(empty);
    expect(result.total).toBe(0);
    expect(result.score).toBeNull();
    expect(result.blocked).toBe(true);
  });

  it("NON-VACUOUS: a case with a deliberately WRONG expected top-fact FAILS (proves the grader actually checks something)", async () => {
    const broken: RelevanceFixtureCorpus = {
      ...RELEVANCE_FIXTURE,
      cases: RELEVANCE_FIXTURE.cases.map((c) =>
        c.id === "earbuds-recall@1" ? { ...c, topId: "f-running-1" /* deliberately wrong */ } : c,
      ),
    };
    const result = await runRelevanceEval(broken);
    expect(result.blocked).toBe(true);
    const brokenCase = result.cases.find((c) => c.id === "earbuds-recall@1");
    expect(brokenCase?.pass).toBe(false);
    expect(brokenCase?.fails[0]).toMatch(/expected top=f-running-1/);
    // every OTHER case is untouched and still passes — the failure is specific, not a global collapse
    expect(result.cases.filter((c) => c.id !== "earbuds-recall@1" && !c.pass)).toHaveLength(0);
  });

  it("NON-VACUOUS: recall@k (oneOf) genuinely fails when the expected sibling id can never be recalled", async () => {
    const broken: RelevanceFixtureCorpus = {
      ...RELEVANCE_FIXTURE,
      cases: RELEVANCE_FIXTURE.cases.map((c) =>
        c.id === "earbuds-recall@k" ? { ...c, oneOf: ["f-budget-1" /* nowhere near this query — can never rank in */] } : c,
      ),
    };
    const result = await runRelevanceEval(broken);
    const brokenCase = result.cases.find((c) => c.id === "earbuds-recall@k");
    expect(brokenCase?.pass).toBe(false);
    expect(brokenCase?.fails.join(" ")).toMatch(/no relevant fact/);
  });

  describe("gradeRelevanceCase (pure grader — retrieval-eval.ts's gradeRetrieval shape: topId≈expectTop, oneOf≈relevantInTopK)", () => {
    it("passes when topId is recalled first", () => {
      const g = gradeRelevanceCase({ id: "c", query: "q", queryVector: [1], topId: "a" }, ["a", "b"]);
      expect(g).toEqual({ pass: true, fails: [] });
    });
    it("fails when topId is NOT first", () => {
      const g = gradeRelevanceCase({ id: "c", query: "q", queryVector: [1], topId: "a" }, ["b", "a"]);
      expect(g.pass).toBe(false);
      expect(g.fails[0]).toMatch(/expected top=a, got b/);
    });
    it("passes oneOf when ANY listed id is present anywhere", () => {
      const g = gradeRelevanceCase({ id: "c", query: "q", queryVector: [1], oneOf: ["x", "y"] }, ["z", "y"]);
      expect(g.pass).toBe(true);
    });
    it("fails oneOf when NONE of the listed ids are present", () => {
      const g = gradeRelevanceCase({ id: "c", query: "q", queryVector: [1], oneOf: ["x", "y"] }, ["z"]);
      expect(g.pass).toBe(false);
      expect(g.fails[0]).toMatch(/no relevant fact/);
    });
  });
});

describe("memory-recall-eval — Suite 2: SAFETY FLOOR (zero-tolerance — mirrors PR3's safety-floor fix)", () => {
  it("a pinned allergy fact (class:special/mustRecall) is recalled even against a query ORTHOGONAL to everything seeded", async () => {
    const result = await runSafetyFloorOrthogonalQueryCase();
    expect(result.pass).toBe(true);
    expect(result.fails).toEqual([]);
  });

  it("FLAG-OFF-THEN-ON: a class:special fact with NO mustRecall stamp (written before semantic recall existed) still surfaces once the flag flips on", async () => {
    const result = await runSafetyFloorLegacyNoMustRecallCase();
    expect(result.pass).toBe(true);
    expect(result.fails).toEqual([]);
  });

  it("the aggregate safety-floor suite is a clean 2/2 pass, never null (a fixed governance invariant set, not a variable corpus)", async () => {
    const result = await runSafetyFloorEval();
    expect(result.total).toBe(2);
    expect(result.score).toBe(100);
    expect(result.blocked).toBe(false);
  });

  it("NON-VACUOUS: withdrawn special consent (consent2='out') means the allergy fact is never written, and the case correctly FAILS — proves this really exercises the write-time consent gate, not a hardcoded pass", async () => {
    const result = await runSafetyFloorOrthogonalQueryCase("out");
    expect(result.pass).toBe(false);
    expect(result.fails.join(" ")).toMatch(/pinned safety fact missing from recall/);
  });

  it("NON-VACUOUS: consent2='unknown' (never explicitly granted) also refuses the special write in every region, including US — the case FAILS", async () => {
    const result = await runSafetyFloorOrthogonalQueryCase("unknown");
    expect(result.pass).toBe(false);
  });
});

describe("memory-recall-eval — Suite 3: DEDUP QUALITY", () => {
  it("the fixture's 3 near-identical paraphrases collapse to EXACTLY 1 record, and its 3 genuinely-distinct facts are ALL retained", async () => {
    const result = await runDedupEval();
    if (result.cases.some((c) => !c.pass)) console.error(JSON.stringify(result.cases, null, 2));
    expect(result.total).toBe(2); // paraphrases-collapse + distinct-retained (no unexpected-records case)
    expect(result.score).toBe(100);
    expect(result.blocked).toBe(false);
    const paraphraseCase = result.cases.find((c) => c.id === "dedup-paraphrases-collapse-to-one");
    const distinctCase = result.cases.find((c) => c.id === "dedup-distinct-facts-all-retained");
    expect(paraphraseCase?.pass).toBe(true);
    expect(distinctCase?.pass).toBe(true);
  });

  it("an EMPTY fixture (no paraphrases, no distinct facts) is UNMEASURED (score: null) and BLOCKS", async () => {
    const empty: DedupFixtureCorpus = { paraphrases: [], distinct: [] };
    const result = await runDedupEval(empty);
    expect(result.total).toBe(0);
    expect(result.score).toBeNull();
    expect(result.blocked).toBe(true);
  });

  it("NON-VACUOUS: an impossibly-high MEMORY_DEDUP_THRESHOLD (1.1 — no real cosine can ever clear it) means the paraphrases NEVER collapse, and the eval correctly reports that as a FAILURE — proves this genuinely measures dedup behavior against the real threshold knob, not a hardcoded pass", async () => {
    process.env.MEMORY_DEDUP_THRESHOLD = "1.1";
    try {
      const result = await runDedupEval();
      const paraphraseCase = result.cases.find((c) => c.id === "dedup-paraphrases-collapse-to-one");
      expect(paraphraseCase?.pass).toBe(false);
      expect(paraphraseCase?.fails.join(" ")).toMatch(/expected exactly 1 stored record/);
      expect(result.blocked).toBe(true);
    } finally {
      delete process.env.MEMORY_DEDUP_THRESHOLD;
    }
  });

  it("this eval's fixture facts are genuinely classified ORDINARY (fixture-drift guard: if any distiller text ever matched a special keyword, the write-time behavior — and so this suite's grading — would silently change)", async () => {
    // A cheap, deterministic sanity check independent of the vector math above: every fixture text must
    // round-trip through the ordinary path (no encryption key is configured for this suite at all).
    const result = await runDedupEval();
    expect(result.cases.find((c) => c.id === "dedup-no-unexpected-records")).toBeUndefined();
  });
});

describe("eval-memory-recall CLI — runMemoryRecallEval (the promotion-evidence + gate entry point)", () => {
  it("aggregates all three suites, blocked=false on the standing fixtures, and does not require Vertex/real creds", async () => {
    const result = await runMemoryRecallEval({ writeEvidence: false });
    expect(result.suites.map((s) => s.suite).sort()).toEqual(["dedup", "relevance", "safety-floor"]);
    expect(result.suites.every((s) => s.embedModel === EVAL_EMBED_MODEL_ID)).toBe(true);
    expect(result.blocked).toBe(false);
  });

  it("writes a structured evidence artifact when writeEvidence is not explicitly disabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-recall-eval-"));
    try {
      const result = await runMemoryRecallEval({ evidenceDir: dir });
      expect(result.evidencePath).toBeDefined();
      const written = JSON.parse(readFileSync(result.evidencePath!, "utf8"));
      expect(written).toHaveLength(3);
      expect(written.map((s: { suite: string }) => s.suite).sort()).toEqual(["dedup", "relevance", "safety-floor"]);
      for (const s of written) {
        expect(typeof s.blocked).toBe("boolean");
        expect(Array.isArray(s.cases)).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("evidence is skipped when writeEvidence:false — the unit-test path never touches the filesystem", async () => {
    const result = await runMemoryRecallEval({ writeEvidence: false });
    expect(result.evidencePath).toBeUndefined();
  });
});
