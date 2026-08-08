// 3b (ADR-0020) — the OUTGOING-OFFER-CHECK eval runner. Runs each reply through the real semantic checker
// (classifyOutgoingOffer) on the real model and grades the boolean verdict exactly. This is the classifier-
// correctness gate the OUTGOING_OFFER_CHECK promotion needs (eval → shadow → canary → human, HITL §5).
// Requires Vertex creds. Non-English cases (advisory:true) run but do NOT gate until native-vetted.
//   pnpm eval:offer-check
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createVertexAdapter, isVertexConfigured } from "@palup/model-vertex";
import { classifyOutgoingOffer } from "@palup/widget-brain";
import { gradeOfferCheck, type OfferCase } from "./offer-check-harness.js";

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  if (!isVertexConfigured()) {
    console.error("Set GOOGLE_CLOUD_PROJECT + ADC — offer-check runs the checker on the real model.");
    process.exit(2);
  }
  const { cases } = JSON.parse(readFileSync(join(here, "..", "cases", "offer-check.json"), "utf8")) as { cases: OfferCase[] };
  const model = createVertexAdapter();
  const rows: { id: string; advisory: boolean; pass: boolean; fail?: string; got?: boolean }[] = [];
  for (const c of cases) {
    try {
      const actual = await classifyOutgoingOffer(model, c.message, "eval");
      const g = gradeOfferCheck(c.expect, actual);
      rows.push({ id: c.id, advisory: !!c.advisory, pass: g.pass, fail: g.fail, got: actual });
      process.stdout.write(`${g.pass ? "✅" : c.advisory ? "⚠️" : "❌"} ${c.id} `);
    } catch (e) {
      rows.push({ id: c.id, advisory: !!c.advisory, pass: false, fail: `error: ${(e as Error).message}` });
      process.stdout.write(`⚠️ ${c.id} `);
    }
  }
  const gating = rows.filter((r) => !r.advisory);
  const advisory = rows.filter((r) => r.advisory);
  const gateFails = gating.filter((r) => !r.pass);
  console.log(`\n\nOFFER-CHECK (gating): ${gating.length - gateFails.length}/${gating.length} passed`);
  for (const r of gateFails) console.log(`  ❌ ${r.id}: ${r.fail} (got ${r.got})`);
  if (advisory.length) {
    const advFails = advisory.filter((r) => !r.pass);
    console.log(`OFFER-CHECK (advisory, non-gating — needs native vetting): ${advisory.length - advFails.length}/${advisory.length} passed`);
    for (const r of advFails) console.log(`  ⚠️ ${r.id}: ${r.fail} (got ${r.got})`);
  }
  if (gateFails.length > 0) {
    console.error(`\nOFFER-CHECK GATE FAIL — ${gateFails.length} gating case(s). A missed invent ships a money offer; a false flag blocks a legit reply.`);
    process.exit(1);
  }
  console.log("OFFER-CHECK GATE OK.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
