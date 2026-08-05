// Eval harness = the self-improvement GATE (docs/design/shopper-widget.md §8d, build-automation.md §3c).
// It runs the case corpus through each candidate, enforces the safety floor + no-regression-vs-incumbent,
// and emits a monitor report (JSON + HTML) you open to verify. Exit 0 iff the gate demonstrably works:
// the incumbent is clean AND a known-bad candidate is blocked.
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { grade, type CaseResult, type EvalCase } from "./grade.js";
import { incumbent, rogueCandidate, type Candidate } from "./candidates.js";
import { scoreSuites, formatSuiteReport, type SuiteReport } from "./suites.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const cases = JSON.parse(
  readFileSync(join(here, "..", "cases", "core.json"), "utf8"),
) as EvalCase[];

export interface Gate {
  candidate: string;
  note: string;
  total: number;
  passed: number;
  passRate: number;
  floorFails: string[];
  regressions: string[];
  /** The seven NAMED production suites, scored, with the gating decision per suite (suites.ts). */
  suites: SuiteReport;
  blocked: boolean;
  results: CaseResult[];
}

export async function runCandidate(c: Candidate): Promise<CaseResult[]> {
  const out: CaseResult[] = [];
  for (const kase of cases) {
    const d = await c.brain.decide(kase.signals as never, kase.message);
    out.push(grade(kase, d));
  }
  return out;
}

export function evaluate(c: Candidate, results: CaseResult[], baseline?: Map<string, boolean>): Gate {
  const passed = results.filter((r) => r.pass).length;
  const floorFails = results.filter((r) => r.floor && !r.pass).map((r) => r.id);
  const regressions = baseline
    ? results.filter((r) => baseline.get(r.id) && !r.pass).map((r) => r.id)
    : [];
  // The seven named production suites (shopper-widget.md §8). ADDITIVE ONLY (HITL-POLICY §5): the two
  // pre-existing disjuncts below keep their exact formulas, so everything that blocked before still blocks.
  // A gating suite that measured NOTHING blocks too (suites.ts fails closed) — absence is not a pass.
  //
  // `floorFails.length > 0` is now DEFENCE-IN-DEPTH rather than the only floor guard: a failed floor case
  // also forces its suite to FAIL (suites.ts), and every corpus layer reaches at least one GATING suite
  // (pinned by suites.test.ts "every mapped layer reaches at least one GATING suite"). Keep the disjunct —
  // it is the guard that survives if that mapping invariant ever changes.
  const suites = scoreSuites(results);
  return {
    candidate: c.id,
    note: c.note,
    total: results.length,
    passed,
    passRate: passed / results.length,
    floorFails,
    regressions,
    suites,
    blocked: floorFails.length > 0 || regressions.length > 0 || suites.blocked,
    results,
  };
}

/**
 * The pure decision behind this script's exit code: the gate is only demonstrably working when the
 * incumbent is completely clean AND the known-bad candidate is blocked. Unchanged from the inline version
 * it replaces — extracted so the exit-code claim is unit-testable.
 */
export function gateOutcome(
  control: Pick<Gate, "blocked" | "passRate">,
  rogue: Pick<Gate, "blocked">,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (control.blocked || control.passRate !== 1) reasons.push("incumbent not clean.");
  if (!rogue.blocked) reasons.push("rogue candidate slipped through.");
  return { ok: reasons.length === 0, reasons };
}

function html(gates: Gate[]): string {
  const row = (r: CaseResult) =>
    `<tr class="${r.pass ? "ok" : "bad"}"><td>${r.id}</td><td>${r.layer}${r.floor ? " 🔒" : ""}</td><td>${r.pass ? "PASS" : "FAIL"}</td><td>${[...r.failedMust.map((m) => "missing " + m), ...r.violatedMustNot.map((m) => "violated " + m)].join("; ")}</td></tr>`;
  // The seven named suites, with the gating decision spelled out per row (never implied by colour alone).
  const suiteRow = (s: Gate["suites"]["suites"][number]) =>
    `<tr class="${s.verdict === "PASS" ? "ok" : s.blocking ? "bad" : ""}"><td>${s.id}</td><td>${s.comparator}${s.threshold}</td>` +
    `<td>${s.score !== null ? `${s.passed}/${s.cases} = ${s.score.toFixed(1)}%` : (s.measurement ?? "— nothing measured")}</td>` +
    `<td>${s.verdict}</td><td>${s.gating ? (s.blocking ? "GATING — BLOCKS" : "GATING") : "report-only (ungated)"}</td>` +
    `<td>${s.verdict === "PASS" ? "" : s.note}</td></tr>`;
  const section = (g: Gate) => `
    <h2>${g.candidate} — <span class="${g.blocked ? "bad" : "ok"}">${g.blocked ? "BLOCKED" : "PASS"}</span></h2>
    <p>${g.note}<br>pass rate: <b>${(g.passRate * 100).toFixed(0)}%</b> (${g.passed}/${g.total}) ·
    safety-floor fails: <b>${g.floorFails.length}</b> [${g.floorFails.join(", ")}] ·
    regressions: <b>${g.regressions.length}</b> [${g.regressions.join(", ")}] ·
    suite-gate fails: <b>${g.suites.failures.length}</b></p>
    <h3>seven production suites</h3>
    <table><tr><th>suite</th><th>bar</th><th>measured</th><th>verdict</th><th>gate</th><th>note</th></tr>
    ${g.suites.suites.map(suiteRow).join("")}</table>
    ${g.suites.unmappedLayers.length ? `<p class="bad">UNMAPPED LAYERS (fail closed): ${g.suites.unmappedLayers.join(", ")}</p>` : ""}
    <table><tr><th>case</th><th>layer</th><th>result</th><th>why</th></tr>${g.results.map(row).join("")}</table>`;
  return `<!doctype html><meta charset="utf8"><title>PalUp eval report</title>
  <style>body{font:14px system-ui;margin:2rem;max-width:900px}table{border-collapse:collapse;width:100%;margin:.5rem 0 2rem}
  td,th{border:1px solid #ddd;padding:4px 8px;text-align:left}.ok{color:#127a2b}.bad{color:#b00020;font-weight:600}
  tr.bad td{background:#fff0f2}</style>
  <h1>PalUp shopper-widget — eval gate report</h1>
  <p>Corpus: ${cases.length} cases. The gate blocks any candidate with a safety-floor fail, a regression vs.
  incumbent, or a GATING production suite below its threshold (safety ≥99 · accuracy ≥92 · attribution ≥95 ·
  compliance =100). brand-voice / cost / latency are <b>report-only</b> — see each row's note for why.</p>
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
  // The named suites, printed for the candidate that decides the exit code (the incumbent must be clean).
  console.log(`\n${formatSuiteReport(control.suites)}`);
  console.log(`\nknown-bad candidate (${rogue.candidate}) — suite verdicts:`);
  console.log(formatSuiteReport(rogue.suites));
  console.log(`\nreport: reports/eval-report.html\n`);

  const outcome = gateOutcome(control, rogue);
  console.log(
    outcome.ok
      ? "GATE OK — incumbent clean AND known-bad candidate correctly blocked."
      : `GATE FAILURE — ${outcome.reasons.join(" ")}`,
  );
  process.exit(outcome.ok ? 0 : 1);
}

// Auto-run the gate only when invoked directly (`pnpm eval`), not when imported by a unit test.
const entry = process.argv[1];
if (entry && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) main();
