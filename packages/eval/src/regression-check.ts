// Compares the latest live gap map (reports/full-eval-report.json) to the committed baseline
// (.github/eval-baseline.json) and FAILS (exit 1) on a regression beyond tolerance — so a quality
// drop surfaces itself instead of relying on someone remembering to look. Tolerances are generous to
// absorb the live judge's run-to-run variance; they catch real collapses, not noise.
//   pnpm eval:regression
import { readFileSync, appendFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface LiveReport {
  passed: number;
  total: number;
  byLayer: Record<string, { pass: number; total: number }>;
  floorFails?: string[];
}
export interface Baseline {
  overall: number;
  byLayer: Record<string, number>;
}
export interface RegressionResult {
  lines: string[];
  regressions: string[];
}

// Pure gate logic: no I/O, no exit. Given a live report + committed baseline + tolerances, produce the
// human-readable gap-map lines and the list of regressions beyond tolerance. A regression is a strict
// drop below (baseline − tolerance) on the overall rate or any layer, or any safety/injection floor fail.
export function computeRegressions(
  report: LiveReport,
  baseline: Baseline,
  opts: { overallTol: number; layerTol: number },
): RegressionResult {
  const { overallTol, layerTol } = opts;
  const rate = (s: { pass: number; total: number }) => (s.total ? s.pass / s.total : 0);
  const overall = report.passed / report.total;
  const lines: string[] = [];
  const regressions: string[] = [];

  lines.push(`## Live judge gap map`);
  lines.push(`overall **${(overall * 100).toFixed(0)}%** (${report.passed}/${report.total}) — baseline ${(baseline.overall * 100).toFixed(0)}%`);
  if (overall < baseline.overall - overallTol) {
    regressions.push(`overall ${(overall * 100).toFixed(0)}% < baseline ${(baseline.overall * 100).toFixed(0)}% − ${overallTol * 100}pp`);
  }

  lines.push(`\n| layer | now | baseline | Δ |`, `|---|---|---|---|`);
  for (const [layer, s] of Object.entries(report.byLayer).sort()) {
    const now = rate(s);
    const base = baseline.byLayer[layer];
    if (base === undefined) continue;
    const delta = now - base;
    const bad = now < base - layerTol;
    if (bad) regressions.push(`${layer} ${(now * 100).toFixed(0)}% < baseline ${(base * 100).toFixed(0)}% − ${layerTol * 100}pp`);
    lines.push(`| ${layer}${bad ? " ⚠️" : ""} | ${(now * 100).toFixed(0)}% | ${(base * 100).toFixed(0)}% | ${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(0)}pp |`);
  }

  if (report.floorFails?.length) regressions.push(`safety/injection floor fails: ${report.floorFails.join(", ")}`);

  return { lines, regressions };
}

function main() {
  const OVERALL_TOL = Number(process.env.OVERALL_TOL ?? 0.1); // fail if overall drops >10pp below baseline
  const LAYER_TOL = Number(process.env.LAYER_TOL ?? 0.2); // fail if any layer drops >20pp below baseline
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..", "..", "..");
  const report = JSON.parse(readFileSync(join(repoRoot, "reports", "full-eval-report.json"), "utf8")) as LiveReport;
  const baseline = JSON.parse(readFileSync(join(repoRoot, ".github", "eval-baseline.json"), "utf8")) as Baseline;

  const { lines, regressions } = computeRegressions(report, baseline, { overallTol: OVERALL_TOL, layerTol: LAYER_TOL });
  const summary =
    lines.join("\n") +
    (regressions.length ? `\n\n### ❌ REGRESSIONS\n- ${regressions.join("\n- ")}` : `\n\n### ✅ no regression beyond tolerance`);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");

  if (regressions.length) {
    console.error(`\nREGRESSION CHECK FAILED (${regressions.length}).`);
    process.exit(1);
  }
  console.log("\nregression check OK.");
}

// Run only when invoked directly (`pnpm eval:regression`), not when imported by a unit test.
const entry = process.argv[1];
if (entry && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) main();
