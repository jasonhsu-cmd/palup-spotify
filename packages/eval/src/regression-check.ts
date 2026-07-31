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
  opts: { overallTol: number; layerTol: number; minCaseDrop?: number },
): RegressionResult {
  const { overallTol, layerTol, minCaseDrop = 2 } = opts;
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
    const belowTol = now < base - layerTol;
    // Small-layer noise guard: the live judge flips individual cases run-to-run, so a rate drop on a tiny
    // layer (e.g. identity, n=3) can exceed layerTol from a SINGLE case flip. Require the drop to also be
    // at least `minCaseDrop` ACTUAL cases below the baseline's expected count before it counts as a
    // regression. The overall + floor checks still catch broad erosion and any safety/injection fail, so
    // this only suppresses statistical noise, never a real collapse.
    const caseDrop = Math.round(base * s.total) - s.pass;
    const bad = belowTol && caseDrop >= minCaseDrop;
    const noiseSuppressed = belowTol && !bad;
    if (bad) regressions.push(`${layer} ${(now * 100).toFixed(0)}% < baseline ${(base * 100).toFixed(0)}% − ${layerTol * 100}pp (−${caseDrop} cases)`);
    const mark = bad ? " ⚠️" : noiseSuppressed ? " ~" : "";
    lines.push(`| ${layer}${mark} | ${(now * 100).toFixed(0)}% | ${(base * 100).toFixed(0)}% | ${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(0)}pp${noiseSuppressed ? ` (−${caseDrop} case, within noise)` : ""} |`);
  }

  if (report.floorFails?.length) regressions.push(`safety/injection floor fails: ${report.floorFails.join(", ")}`);

  return { lines, regressions };
}

function main() {
  const OVERALL_TOL = Number(process.env.OVERALL_TOL ?? 0.1); // fail if overall drops >10pp below baseline
  const LAYER_TOL = Number(process.env.LAYER_TOL ?? 0.2); // fail if any layer drops >20pp below baseline
  const MIN_CASE_DROP = Number(process.env.MIN_CASE_DROP ?? 2); // AND ≥2 actual cases below expected (small-n noise guard)
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..", "..", "..");
  const report = JSON.parse(readFileSync(join(repoRoot, "reports", "full-eval-report.json"), "utf8")) as LiveReport;
  const baseline = JSON.parse(readFileSync(join(repoRoot, ".github", "eval-baseline.json"), "utf8")) as Baseline;

  const { lines, regressions } = computeRegressions(report, baseline, { overallTol: OVERALL_TOL, layerTol: LAYER_TOL, minCaseDrop: MIN_CASE_DROP });
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
