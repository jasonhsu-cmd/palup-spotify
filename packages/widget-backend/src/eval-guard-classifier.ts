// broaden (ADR-0020) — the SERVER GUARD CLASSIFIER eval runner. Runs each shopper message through the real
// classifier (classifyGuardSignals) on the real model and grades the signals exactly. This is the
// classifier-correctness gate the SERVER_GUARD_SIGNALS promotion needs (eval → shadow → canary → human,
// HITL §5). Requires Vertex creds. Non-English cases (advisory:true) run but do NOT gate until native-vetted.
//   pnpm eval:guard-classifier
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createVertexAdapter, isVertexConfigured } from "@palup/model-vertex";
import { classifyGuardSignals } from "./guard-classifier.js";
import { gradeGuardSignals, type GuardCase } from "./guard-classifier-eval.js";

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  if (!isVertexConfigured()) {
    console.error("Set GOOGLE_CLOUD_PROJECT + ADC — guard-classifier runs on the real model.");
    process.exit(2);
  }
  const { cases } = JSON.parse(readFileSync(join(here, "..", "cases", "guard-classifier.json"), "utf8")) as { cases: GuardCase[] };
  const model = createVertexAdapter();
  const rows: { id: string; advisory: boolean; pass: boolean; fails: string[] }[] = [];
  for (const c of cases) {
    try {
      const got = await classifyGuardSignals(model, c.message, "eval");
      const g = gradeGuardSignals(c.expect, got);
      rows.push({ id: c.id, advisory: !!c.advisory, pass: g.pass, fails: g.fails });
      process.stdout.write(`${g.pass ? "✅" : c.advisory ? "⚠️" : "❌"} ${c.id} `);
    } catch (e) {
      rows.push({ id: c.id, advisory: !!c.advisory, pass: false, fails: [`error: ${(e as Error).message}`] });
      process.stdout.write(`⚠️ ${c.id} `);
    }
  }
  const gating = rows.filter((r) => !r.advisory);
  const advisory = rows.filter((r) => r.advisory);
  const gateFails = gating.filter((r) => !r.pass);
  console.log(`\n\nGUARD-CLASSIFIER (gating): ${gating.length - gateFails.length}/${gating.length} passed`);
  for (const r of gateFails) console.log(`  ❌ ${r.id}: ${r.fails.join("; ")}`);
  if (advisory.length) {
    const advFails = advisory.filter((r) => !r.pass);
    console.log(`GUARD-CLASSIFIER (advisory, non-gating — needs native vetting): ${advisory.length - advFails.length}/${advisory.length} passed`);
    for (const r of advFails) console.log(`  ⚠️ ${r.id}: ${r.fails.join("; ")}`);
  }
  if (gateFails.length > 0) {
    console.error(`\nGUARD-CLASSIFIER GATE FAIL — ${gateFails.length} gating case(s) misclassified.`);
    process.exit(1);
  }
  console.log("GUARD-CLASSIFIER GATE OK.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
