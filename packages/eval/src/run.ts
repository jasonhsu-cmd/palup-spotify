// Eval harness = the self-improvement GATE (docs/design/shopper-widget.md §8d, build-automation.md §3c).
// It runs the case corpus through each candidate, enforces the safety floor + no-regression-vs-incumbent,
// and emits a monitor report (JSON + HTML) you open to verify. Exit 0 iff the gate demonstrably works:
// the incumbent is clean AND a known-bad candidate is blocked.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { grade, type CaseResult, type EvalCase } from "./grade.js";
import { incumbent, rogueCandidate, type Candidate } from "./candidates.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const cases = JSON.parse(
  readFileSync(join(here, "..", "cases", "core.json"), "utf8"),
) as EvalCase[];

interface Gate {
  candidate: string;
  note: string;
  total: number;
  passed: number;
  passRate: number;
  floorFails: string[];
  regressions: string[];
  blocked: boolean;
  results: CaseResult[];
}

async function runCandidate(c: Candidate): Promise<CaseResult[]> {
  const out: CaseResult[] = [];
  for (const kase of cases) {
    const d = await c.brain.decide(kase.signals as never, kase.message);
    out.push(grade(kase, d));
  }
  return out;
}

function evaluate(c: Candidate, results: CaseResult[], baseline?: Map<string, boolean>): Gate {
  const passed = results.filter((r) => r.pass).length;
  const floorFails = results.filter((r) => r.floor && !r.pass).map((r) => r.id);
  const regressions = baseline
    ? results.filter((r) => baseline.get(r.id) && !r.pass).map((r) => r.id)
    : [];
  return {
    candidate: c.id,
    note: c.note,
    total: results.length,
    passed,
    passRate: passed / results.length,
    floorFails,
    regressions,
    blocked: floorFails.length > 0 || regressions.length > 0,
    results,
  };
}

function html(gates: Gate[]): string {
  const row = (r: CaseResult) =>
    `<tr class="${r.pass ? "ok" : "bad"}"><td>${r.id}</td><td>${r.layer}${r.floor ? " 🔒" : ""}</td><td>${r.pass ? "PASS" : "FAIL"}</td><td>${[...r.failedMust.map((m) => "missing " + m), ...r.violatedMustNot.map((m) => "violated " + m)].join("; ")}</td></tr>`;
  const section = (g: Gate) => `
    <h2>${g.candidate} — <span class="${g.blocked ? "bad" : "ok"}">${g.blocked ? "BLOCKED" : "PASS"}</span></h2>
    <p>${g.note}<br>pass rate: <b>${(g.passRate * 100).toFixed(0)}%</b> (${g.passed}/${g.total}) ·
    safety-floor fails: <b>${g.floorFails.length}</b> [${g.floorFails.join(", ")}] ·
    regressions: <b>${g.regressions.length}</b> [${g.regressions.join(", ")}]</p>
    <table><tr><th>case</th><th>layer</th><th>result</th><th>why</th></tr>${g.results.map(row).join("")}</table>`;
  return `<!doctype html><meta charset="utf8"><title>PalUp eval report</title>
  <style>body{font:14px system-ui;margin:2rem;max-width:900px}table{border-collapse:collapse;width:100%;margin:.5rem 0 2rem}
  td,th{border:1px solid #ddd;padding:4px 8px;text-align:left}.ok{color:#127a2b}.bad{color:#b00020;font-weight:600}
  tr.bad td{background:#fff0f2}</style>
  <h1>PalUp shopper-widget — eval gate report</h1>
  <p>Corpus: ${cases.length} cases. The gate blocks any candidate with a safety-floor fail or a regression vs. incumbent.</p>
  ${gates.map(section).join("")}`;
}

async function main() {
  const baselineResults = await runCandidate(incumbent);
  const baseline = new Map(baselineResults.map((r) => [r.id, r.pass]));

  const control = evaluate(incumbent, baselineResults);
  const rogueResults = await runCandidate(rogueCandidate);
  const rogue = evaluate(rogueCandidate, rogueResults, baseline);

  const outDir = join(repoRoot, "reports");
  mkdirSync(outDir, { recursive: true });
  const gates = [control, rogue];
  writeFileSync(join(outDir, "eval-report.json"), JSON.stringify(gates, null, 2));
  writeFileSync(join(outDir, "eval-report.html"), html(gates));

  console.log("\n=== PalUp shopper-widget eval gate ===");
  for (const g of gates) {
    console.log(
      `${g.blocked ? "⛔ BLOCKED" : "✅ PASS   "}  ${g.candidate.padEnd(22)} ${(g.passRate * 100).toFixed(0)}% (${g.passed}/${g.total})  floorFails=[${g.floorFails.join(",")}] regressions=[${g.regressions.join(",")}]`,
    );
  }
  console.log(`report: reports/eval-report.html\n`);

  const controlOK = !control.blocked && control.passRate === 1;
  const rogueBlocked = rogue.blocked;
  const gateWorks = controlOK && rogueBlocked;
  console.log(
    gateWorks
      ? "GATE OK — incumbent clean AND known-bad candidate correctly blocked."
      : "GATE FAILURE — " +
          (!controlOK ? "incumbent not clean. " : "") +
          (!rogueBlocked ? "rogue candidate slipped through. " : ""),
  );
  process.exit(gateWorks ? 0 : 1);
}

main();
