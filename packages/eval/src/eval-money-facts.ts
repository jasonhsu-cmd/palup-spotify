// go-live §B — the MONEY-FACTS eval runner. Runs each case's price question through the A1b hydration path
// on the REAL model and grades DETERMINISTICALLY (price-fidelity / staleness fail-honest / cross-tenant).
// Requires GCP creds (Vertex). The harness PLUMBING (facts → prompt → reply → grade) is gate-tested without
// creds by money-facts-harness.test.ts with a scripted model, so a wiring break is caught in CI; this
// runner is the real-model quality measurement a human runs before promoting PRODUCT_FACTS_HYDRATION.
//   pnpm eval:money-facts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createVertexAdapter, isVertexConfigured } from "@palup/model-vertex";
import { buildMoneyFactsBrain, gradeMoneyFacts, type MoneyFactsCase } from "./money-facts-harness.js";

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  if (!isVertexConfigured()) {
    console.error("Set GOOGLE_CLOUD_PROJECT + ADC — money-facts runs the agent on the real model.");
    process.exit(2);
  }
  const { cases } = JSON.parse(readFileSync(join(here, "..", "cases", "money-facts.json"), "utf8")) as { cases: MoneyFactsCase[] };
  const model = createVertexAdapter();
  const results: { id: string; kind: string; pass: boolean; fails: string[]; reply: string }[] = [];
  for (const c of cases) {
    try {
      const brain = await buildMoneyFactsBrain(c, model);
      const d = await brain.decide({ tenantId: c.tenantId } as never, c.message);
      const g = gradeMoneyFacts(c, d.reply);
      results.push({ id: c.id, kind: c.kind, ...g, reply: d.reply });
      process.stdout.write(`${g.pass ? "✅" : "❌"} ${c.id} `);
    } catch (e) {
      results.push({ id: c.id, kind: c.kind, pass: false, fails: [`error: ${(e as Error).message}`], reply: "(error)" });
      process.stdout.write(`⚠️ ${c.id} `);
    }
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n\nMONEY-FACTS: ${passed}/${results.length} passed`);
  for (const r of results.filter((x) => !x.pass)) {
    console.log(`  ❌ ${r.id} (${r.kind}): ${r.fails.join("; ")}\n     reply: ${r.reply.slice(0, 200)}`);
  }
  // GATE: a quoted price is money/NN#1, so a single fabricated / stale-quoted / cross-tenant price fails.
  if (passed !== results.length) {
    console.error(`\nMONEY-FACTS GATE FAIL — ${results.length - passed} case(s) quoted a wrong/stale/forbidden price.`);
    process.exit(1);
  }
  console.log("MONEY-FACTS GATE OK.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
