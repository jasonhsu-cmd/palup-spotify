// Compares the latest live gap map (reports/full-eval-report.json) to the committed baseline
// (.github/eval-baseline.json) and FAILS (exit 1) on a regression beyond tolerance — so a quality
// drop surfaces itself instead of relying on someone remembering to look. Tolerances are generous to
// absorb the live judge's run-to-run variance; they catch real collapses, not noise.
//   pnpm eval:regression
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OVERALL_TOL = Number(process.env.OVERALL_TOL ?? 0.1); // fail if overall drops >10pp below baseline
const LAYER_TOL = Number(process.env.LAYER_TOL ?? 0.2); // fail if a layer drops >20pp below baseline AND…
const MIN_DROP_CASES = Number(process.env.MIN_DROP_CASES ?? 3); // …at least this many cases got worse.
// The case-count guard stops tiny layers (consent/identity/golden are 1-3 cases) from crying "regression"
// on a single judge-variance flip — a 1-case flip in a 2-case layer is 50pp but not a real regression.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const report = JSON.parse(readFileSync(join(repoRoot, "reports", "full-eval-report.json"), "utf8"));
const baseline = JSON.parse(readFileSync(join(repoRoot, ".github", "eval-baseline.json"), "utf8"));

const rate = (s: { pass: number; total: number }) => (s.total ? s.pass / s.total : 0);
const overall = report.passed / report.total;
const lines: string[] = [];
const regressions: string[] = [];

lines.push(`## Live judge gap map`);
lines.push(`overall **${(overall * 100).toFixed(0)}%** (${report.passed}/${report.total}) — baseline ${(baseline.overall * 100).toFixed(0)}%`);
if (overall < baseline.overall - OVERALL_TOL) {
  regressions.push(`overall ${(overall * 100).toFixed(0)}% < baseline ${(baseline.overall * 100).toFixed(0)}% − ${OVERALL_TOL * 100}pp`);
}

lines.push(`\n| layer | now | baseline | Δ |`, `|---|---|---|---|`);
for (const [layer, s] of Object.entries(report.byLayer as Record<string, { pass: number; total: number }>).sort()) {
  const now = rate(s);
  const base = baseline.byLayer[layer];
  if (base === undefined) continue;
  const delta = now - base;
  const droppedCases = (base - now) * s.total; // how many cases got worse vs baseline
  const bad = now < base - LAYER_TOL && droppedCases >= MIN_DROP_CASES;
  if (bad) regressions.push(`${layer} ${(now * 100).toFixed(0)}% < baseline ${(base * 100).toFixed(0)}% − ${LAYER_TOL * 100}pp (${droppedCases.toFixed(1)} cases worse)`);
  lines.push(`| ${layer}${bad ? " ⚠️" : ""} | ${(now * 100).toFixed(0)}% | ${(base * 100).toFixed(0)}% | ${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(0)}pp |`);
}

if (report.floorFails?.length) regressions.push(`safety/injection floor fails: ${report.floorFails.join(", ")}`);

const summary = lines.join("\n") + (regressions.length ? `\n\n### ❌ REGRESSIONS\n- ${regressions.join("\n- ")}` : `\n\n### ✅ no regression beyond tolerance`);
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");

if (regressions.length) {
  console.error(`\nREGRESSION CHECK FAILED (${regressions.length}).`);
  process.exit(1);
}
console.log("\nregression check OK.");
