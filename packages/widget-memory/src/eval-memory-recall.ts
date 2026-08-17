// semantic-memory-v1 (PR4/T10) — the MEMORY_SEMANTIC_RECALL eval CLI: relevance (recall@k) + safety floor +
// dedup quality, all on a deterministic offline fixture with a MOCK embed model (see memory-recall-eval.ts's
// header for why — NEVER real Vertex; this file never imports @palup/model-vertex and never reads
// GOOGLE_CLOUD_PROJECT). Always invoke with `env -u GOOGLE_CLOUD_PROJECT` (never set it):
//   pnpm eval:memory-recall
//
// WHERE THIS SITS IN THE GATE STRUCTURE (read before wiring this into anything else):
//   `pnpm eval` (packages/eval/src/run.ts) is the shopper-TURN seven-production-suite gate
//   (packages/eval/src/suites.ts) — its LAYER_SUITES registry maps a corpus CASE's free-text `layer` to
//   one of the seven named suites (safety/accuracy/brand-voice/attribution/cost/latency/compliance). A
//   memory-recall case is not a shopper turn and carries no `layer` at all, so it has no honest mapping
//   into that registry — forcing one in would be exactly the "manufacture false assurance" LAYER_SUITES's
//   own header warns against. THIS IS THE SAME SHAPE AS `CATALOG_RETRIEVAL`: `pnpm eval:retrieval` /
//   `pnpm shadow:retrieval` are ALSO dedicated scripts outside `pnpm eval`'s seven-suite gate (see
//   docs/DEPLOY.md's "Per-tenant CATALOG_RETRIEVAL promotion" section) — this eval follows that exact,
//   already-established precedent rather than forcing a misfit into the seven-suite registry.
//
// PRECONDITION — flag.ts's ADR-0015 double gate, RESPECTED not bypassed (do NOT flip any flag; flag.ts
// stays untouched, per this eval's own charter). `createMemoryService`'s `deps.enabled` override is a
// TEST-RUNNER-ONLY seam (service.ts's own doc comment: "no caller can enable memory by config alone" —
// NN#1); outside vitest (VITEST=true / NODE_ENV=test) it is silently IGNORED and the real
// `isMemoryEnabled()` decides. `MEMORY_ADR_ACCEPTED` is already `true` in this codebase (flag.ts,
// 2026-08-17 internal-staging acceptance), so the ONE remaining switch this CLI needs, exactly like every
// other caller, is the operator env var `MEMORY_ENABLED=true` for THIS invocation:
//   MEMORY_ENABLED=true pnpm eval:memory-recall
// This never touches any deployed service, shared store, or real serving tenant — every suite in
// memory-recall-eval.ts builds its own fresh, isolated in-memory VectorPort/RuntimeStatePort per run, and
// setting this env var for a local/CI eval process is not the same act as enabling memory on a serving
// deployment (that stays a Cloud Run env var on `palup-widget-staging`, set once, by a human, per flag.ts's
// header). `main()` below checks this explicitly (mirroring eval-retrieval.ts's own `isVertexConfigured()`
// precondition check) and fails LOUDLY with this exact explanation rather than silently measuring nothing.
//
// HUMAN PROMOTION NOTE (precise, not invented — MEMORY_SEMANTIC_RECALL has no HITL-POLICY §5 /
// docs/MEMORY-GO-LIVE-CHECKLIST.md entry yet, and this file does not add one; that is a
// solution-architect / release-manager / named-owner decision, not a test-engineer's to make unilaterally):
//   - This CLI's PASS bar is exit code 0: every one of the three suites below reports `blocked: false`.
//     A suite BLOCKS if ANY case fails, OR (relevance/dedup only) if its fixture measured zero cases —
//     `null`/absent is never a silent pass (mirrors packages/eval/src/suites.ts's own discipline).
//   - A green run here is evidence the WIRING is correct on a hand-authored, unambiguous, offline fixture
//     with a mock embed model. It is NOT an at-scale measurement on real embeddings (there is none — this
//     package has no Vertex dependency) and it does NOT by itself justify flipping MEMORY_SEMANTIC_RECALL,
//     MEMORY_ENABLED, or MEMORY_ADR_ACCEPTED — those stay governed exactly as flag.ts / service.ts's own
//     doc comments describe (a reviewed, human-merged code change, never a config flip this CLI performs).
//   - Before any human promotes on MEMORY_SEMANTIC_RECALL, a runbook analogous to DEPLOY.md's
//     "Per-tenant CATALOG_RETRIEVAL promotion" section needs to be authored (naming the same
//     preconditions/evidence-review/rollback structure) — this CLI supplies the evidence artifact half of
//     that, not the governance decision itself.
import { runRelevanceEval, runSafetyFloorEval, runDedupEval, EVAL_EMBED_MODEL_ID } from "./memory-recall-eval.js";
import { suiteToEvidence, writeMemoryRecallEvidence, type MemoryRecallPromotionEvidence } from "./memory-recall-promotion-evidence.js";
import { isMemoryEnabled } from "./flag.js";

export interface RunMemoryRecallEvalResult {
  suites: MemoryRecallPromotionEvidence[];
  blocked: boolean;
  evidencePath?: string;
}

export async function runMemoryRecallEval(opts: { writeEvidence?: boolean; evidenceDir?: string } = {}): Promise<RunMemoryRecallEvalResult> {
  const at = new Date().toISOString();
  const relevance = await runRelevanceEval();
  const safety = await runSafetyFloorEval();
  const dedup = await runDedupEval();

  const suites: MemoryRecallPromotionEvidence[] = [
    suiteToEvidence("relevance", relevance, EVAL_EMBED_MODEL_ID, at),
    suiteToEvidence("safety-floor", safety, EVAL_EMBED_MODEL_ID, at),
    suiteToEvidence("dedup", dedup, EVAL_EMBED_MODEL_ID, at),
  ];

  // Fail closed on the aggregate the same way each suite fails closed internally: ANY blocking suite
  // blocks this whole run, and a suite that measured nothing (score === null) is ALWAYS blocking (see
  // memory-recall-eval.ts `summarize`) — never averaged away against the other two suites' passes.
  const blocked = suites.some((s) => s.blocked);

  let evidencePath: string | undefined;
  if (opts.writeEvidence !== false) evidencePath = writeMemoryRecallEvidence(suites, opts.evidenceDir);

  return { suites, blocked, evidencePath };
}

async function main() {
  // See this file's own "PRECONDITION" header comment: outside a test runner, `createMemoryService`'s
  // `deps.enabled` override is inert by design (NN#1) — the REAL `isMemoryEnabled()` decides. Checked
  // explicitly, up front, so a misconfigured invocation fails with an actionable message instead of a
  // confusing "wrote 0 of N facts" fixture-drift error deep inside the relevance suite.
  if (!isMemoryEnabled()) {
    console.error(
      "MEMORY_ENABLED is not \"true\" for this process — flag.ts's ADR-0015 double gate is OFF here, so " +
        "remember()/recall() are no-ops for every suite below (this is NOT a bug in the eval; it is the same " +
        "gate every other caller of @palup/widget-memory respects). Run this exact CLI with:\n" +
        "  MEMORY_ENABLED=true pnpm eval:memory-recall\n" +
        "This does NOT enable memory on any deployed service or shared store — every suite here builds its own " +
        "fresh, isolated in-memory VectorPort/RuntimeStatePort for the lifetime of this one process, and this " +
        "file never touches flag.ts. `pnpm test` (vitest) does not need this: its own TEST-RUNNER-ONLY seam " +
        "(service.ts's `deps.enabled`) is what those tests use instead.",
    );
    process.exit(2);
  }
  const result = await runMemoryRecallEval();
  for (const s of result.suites) {
    const measured = s.score === null ? "UNMEASURED (no cases — an absent measurement is not a pass)" : `${s.passed}/${s.total} = ${s.score.toFixed(1)}%`;
    console.log(`\n${s.blocked ? "⛔ BLOCKED" : "✅ PASS   "}  ${s.suite.padEnd(13)} ${measured}`);
    for (const c of s.cases.filter((c) => !c.pass)) console.log(`   ❌ ${c.id}: ${c.fails.join("; ")}`);
  }
  if (result.evidencePath) console.log(`\n[eval-memory-recall] evidence written: ${result.evidencePath}`);
  if (result.blocked) {
    console.error(
      "\nMEMORY_RECALL_EVAL GATE FAIL — see the suite(s) above. This is a DEDICATED gate: it does not run " +
        "inside `pnpm eval`'s seven-suite gate (see this file's header) and it does not flip MEMORY_SEMANTIC_RECALL.",
    );
    process.exit(1);
  }
  console.log(
    "\nMEMORY_RECALL_EVAL GATE OK — relevance (recall@k), safety-floor, and dedup all pass on this deterministic " +
      "offline fixture (mock embed model, no real Vertex). See this file's header for what this does — and does not — authorize.",
  );
}

// Run only as a script (`pnpm eval:memory-recall`), never on import — same guard as
// widget-backend/src/eval-retrieval.ts and every other jobs/*.ts CLI in this repo.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
