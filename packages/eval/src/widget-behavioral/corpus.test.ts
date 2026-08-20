import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCases } from "./load.js";
import { runSingle } from "./run-single.js";
import { runMulti } from "./run-multi.js";
import { genPairwiseCases } from "./gen-pairwise-cases.js";

// Task 8/10 — corpus smoke test. Runs on vitest (the repo's real runner — see load.test.ts's task-1
// override note; the brief's illustrative node:test/tsx snippet does not match how this package's
// suite actually executes). This is a SMOKE test only: it asserts every case in
// cases/widget-behavioral.json (plus the runtime-generated pairwise slice, Task 10) loads and RUNS
// to completion without throwing, and that every risk family required so far is present. It must NOT
// assert the agent passes its own behavioral `expect` — a case whose `expect` the brain fails to meet
// is a recorded FINDING (see main.ts's aggregated report), not a harness defect, and asserting
// pass/fail here would turn honest findings into red CI. This includes the Task-10 language family:
// those cases are AUTHORED to the correct safety/health bar and are EXPECTED to fail structurally
// (the English-keyword-only classifiers miss non-English text on the Layer-1 mock path) — that is a
// recorded finding, not a reason to skip/xfail them, and this smoke test only checks they run.
describe("widget-behavioral corpus", () => {
  const casesPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "cases", "widget-behavioral.json");

  it("every case loads and runs without throwing; each risk family is represented", async () => {
    const cases = loadCases(casesPath);
    expect(cases.length).toBeGreaterThan(0);

    for (const c of cases) {
      // Must not throw — whether the structural grade passes or fails is irrelevant here.
      await (c.turns ? runMulti(c) : runSingle(c));
    }

    const families = new Set(cases.map((c) => c.family));
    for (const f of [
      "safety", "aggression", "voice", "situational", "grounding-integrity", "support", "persona-role",
      "language", "timing", "memory", "multi-turn", "mode-backbone",
    ]) {
      expect(families.has(f), `missing family: ${f}`).toBe(true);
    }
  });

  // Task 10 — pairwise (Slice B) is generated at runtime (kept OUT of the hand-authored JSON, wired
  // into main.ts via genPairwiseCases()). Documented here rather than asserted against the JSON's own
  // family set above: the JSON corpus intentionally never contains family "pairwise" cases.
  it("the runtime-generated pairwise slice loads and runs without throwing", async () => {
    const cases = genPairwiseCases();
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      await runSingle(c);
    }
    expect(cases.every((c) => c.family === "pairwise")).toBe(true);
  });
});
