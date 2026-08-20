import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCases } from "./load.js";
import { runSingle } from "./run-single.js";
import { runMulti } from "./run-multi.js";

// Task 8 — corpus smoke test. Runs on vitest (the repo's real runner — see load.test.ts's task-1
// override note; the brief's illustrative node:test/tsx snippet does not match how this package's
// suite actually executes). This is a SMOKE test only: it asserts every case in
// cases/widget-behavioral.json loads and RUNS to completion without throwing, and that the four
// Task-8 risk families are present. It must NOT assert the agent passes its own behavioral `expect`
// — a case whose `expect` the brain fails to meet is a recorded FINDING (see main.ts's aggregated
// report), not a harness defect, and asserting pass/fail here would turn honest findings into red CI.
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
    for (const f of ["safety", "aggression", "voice", "situational"]) {
      expect(families.has(f), `missing family: ${f}`).toBe(true);
    }
  });
});
