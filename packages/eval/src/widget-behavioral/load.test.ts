import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCases } from "./load.js";

// Task 1 (harness scaffold): the loader is the foundation every later widget-behavioral task
// builds on, so it earns its own test — same pattern as packages/widget-backend/test/eval-retrieval-cli.test.ts
// (mkdtempSync a real JSON fixture, no mocked fs). Runs via the repo's real runner (vitest, matched to
// packages/eval/test/*.test.ts and packages/widget-brain/test/*.test.ts) — NOT node:test/tsx as the
// brief's illustrative snippet showed; see task-1-report.md for the Step-1 runner-discovery rationale.
describe("loadCases", () => {
  it("parses a valid case and rejects a case with both message and turns", () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-"));
    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify([{
      id: "t1", family: "safety", severity: "P0", riskClass: "safety",
      signals: { mood: "neutral" }, message: "hi", expect: { mode: "safety" },
    }]));
    const cases = loadCases(good);
    expect(cases.length).toBe(1);
    expect(cases[0]!.id).toBe("t1");

    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify([{
      id: "t2", family: "x", severity: "P0", riskClass: "x",
      signals: {}, message: "a", turns: ["a"],
    }]));
    expect(() => loadCases(bad)).toThrow(/both message and turns|exactly one/i);
  });
});
