// Task 7 — the widget-behavioral harness entry point. Runs every case in the corpus through the
// Task 3 (single-turn) or Task 4 (multi-turn) runner, aggregates the results (Report, above), and
// writes a machine-readable JSON to repo-root `reports/`.
//
// Behavioral failures (a case that runs but the brain's decision doesn't match `expect`/`session`)
// are FINDINGS, not harness errors: this file must print them and still exit 0 — a discovered
// defect (e.g. the seeded f1-distress-gerund safety gap) is the harness doing its job, not a crash.
// Only an actual harness error (a case that won't load or throws while running) should fail the
// process, and that happens naturally: loadCases/runSingle/runMulti throw and main() rejects.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCases } from "./load.js";
import { runSingle } from "./run-single.js";
import { runMulti } from "./run-multi.js";
import { aggregate } from "./aggregate.js";
import { genPairwiseCases } from "./gen-pairwise-cases.js";

const here = dirname(fileURLToPath(import.meta.url));
// here = packages/eval/src/widget-behavioral — 4 levels below repo root (contrast run.ts at
// packages/eval/src/run.ts, which is 3 levels below and uses 3 "..").
const repoRoot = join(here, "..", "..", "..", "..");
const casesPath = join(here, "..", "..", "cases", "widget-behavioral.json");

type Row = {
  id: string;
  family: string;
  severity: string;
  riskClass: string;
  pass: boolean;
  failures: string[];
  signals?: Record<string, unknown>;
};

async function main() {
  // Slice B (spec §4/§6): the pairwise corpus is generated at runtime, not hand-authored into
  // widget-behavioral.json — concatenated here so the full harness run (and the aggregated report)
  // includes it under family "pairwise".
  const cases = [...loadCases(casesPath), ...genPairwiseCases()];
  const rows: Row[] = [];
  for (const c of cases) {
    const o = c.turns ? await runMulti(c) : await runSingle(c);
    rows.push({
      id: o.id,
      family: o.family,
      severity: o.severity,
      riskClass: o.riskClass,
      pass: o.pass,
      failures: o.failures,
      signals: c.signals,
    });
  }
  const report = aggregate(rows);
  const outDir = join(repoRoot, "reports");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "widget-behavioral-results.json"), JSON.stringify({ report, rows }, null, 2));
  console.log(`widget-behavioral: ${report.passed}/${report.total} passed; ${report.failures.length} failures`);
  for (const f of report.failures) {
    console.log(`  ✗ [${f.severity}] ${f.id} (${f.family}): ${f.failures.join("; ")}`);
  }
  // Intentionally exit 0 even with failures present: a failing behavioral case is a reported
  // finding (see file header), not a harness crash. Only a thrown error above (case load/run
  // failure) should produce a non-zero exit, and that happens via the unhandled rejection below.
}

main();
