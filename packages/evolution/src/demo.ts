// Offline demonstration of the governed self-improvement loop (deterministic, no model calls):
// propose candidates -> evaluate -> GATE -> human approve -> promote -> monitor -> auto-rollback.
//   pnpm evo:demo
import { DEFAULT_POLICY } from "@palup/widget-brain";
import { EvolutionEngine, MockGrader, seedCandidates, type PolicyMetrics } from "./index.js";

const scores: Record<string, PolicyMetrics> = {
  [DEFAULT_POLICY.id]: { policyId: DEFAULT_POLICY.id, safetyPass: true, floorPass: true, qualityScore: 0.75, counterMetrics: { returnRate: 0.08, complaintRate: 0.03 } },
  "cand-warm-concise": { policyId: "cand-warm-concise", safetyPass: true, floorPass: true, qualityScore: 0.9, counterMetrics: { returnRate: 0.06, complaintRate: 0.02 } },
  "cand-confident": { policyId: "cand-confident", safetyPass: true, floorPass: true, qualityScore: 0.78, counterMetrics: { returnRate: 0.08, complaintRate: 0.03 } },
  "cand-aggressive": { policyId: "cand-aggressive", safetyPass: true, floorPass: true, qualityScore: 0.66, counterMetrics: { returnRate: 0.18, complaintRate: 0.09 } },
};

async function main() {
  const engine = new EvolutionEngine({
    champion: { policy: DEFAULT_POLICY, metrics: scores[DEFAULT_POLICY.id]! },
    grader: new MockGrader(scores),
  });
  console.log(`\nchampion: ${engine.getChampion().policy.label} (quality ${engine.getChampion().metrics.qualityScore})\n`);

  for (const c of seedCandidates()) {
    engine.propose(c);
    const rec = await engine.evaluate(c.id);
    const mark = rec.status === "awaiting_approval" ? "✅ PASS " : "⛔ BLOCK";
    console.log(
      `${mark} ${c.id.padEnd(18)} q=${rec.metrics!.qualityScore} Δ=${rec.gate!.delta.toFixed(2)}  ${rec.gate!.reasons.join(", ")}`,
    );
  }

  // OFFLINE DEMO ONLY (pnpm evo:demo, MockGrader, disconnected from shoppers): "jason" is a stand-in
  // HUMAN operator approving via the Approval Center — this scripts the human gate, it is not an
  // autonomous approval path. NN #2's human gate is enforced in engine.approve/promote, not here.
  console.log("\n-- human reviews the passing candidate (Approval Center) --");
  engine.approve("cand-warm-concise", "jason");
  const champ = engine.promote("cand-warm-concise");
  console.log(`promoted → new champion: ${champ.policy.label} (quality ${champ.metrics.qualityScore})`);

  console.log("\n-- post-promotion monitor detects a live regression → auto-rollback --");
  const r = engine.monitor({ qualityScore: 0.5, safetyPass: true });
  console.log(`rolledBack=${r.rolledBack} (${r.reason}); champion now: ${engine.getChampion().policy.label}`);

  console.log("\naudit log:");
  for (const a of engine.getAudit()) console.log(`  #${a.seq} [${a.actor}] ${a.action}${a.target ? ` ${a.target}` : ""}`);
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
