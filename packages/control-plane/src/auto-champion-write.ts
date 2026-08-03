import type { RuntimeStatePort } from "@palup/platform-ports";
import type { EvolutionEngine } from "@palup/evolution";
import type { Policy } from "@palup/widget-brain";
import { matchedKill, RUNTIME_AGENT_TYPE, readAutoPromoteEnabled, recordAutoPromotionTx, readAutoStageTx, autoStageComplete } from "@palup/state-postgres";

// ADR-0014 T4d — the single durable serving write for the AUTO path, gated on the ENGINE's auto-lane
// markers (in-process, engine-enforced) AND the durable stage ledger (cross-process). Serving is
// reachable ONLY through this primitive; the orchestrator NEVER calls engine.approve('auto-loop')→promote
// (the path PR #125 abused). Distinct from the HUMAN path (champion-promoter.promoteToServing, which
// REFUSES an auto-loop approver): this is attributed to actor "auto-loop", NEVER "human".
//
// Guard order (all fail-closed, all BEFORE the durable write):
//   1. engine.autoPromotable(id) — the in-process engine markers (gate gating===true + passing shadow +
//      passing canary + awaiting_approval + not killed). An orchestrator bug or a second in-process caller
//      is refused here, mirroring how promoteToServing refuses a non-human approver by reading the record.
//   2. opt-in gate (readAutoPromoteEnabled: per-tenant opt-in AND platform override) + kill (matchedKill,
//      3-scope). Defense in depth; serving's per-turn matchedKill is the always-on enforcement.
//   3. IN the write tx: the durable ledger must show both stages complete (autoStageComplete). This
//      refuses a SEPARATE process that never drove the in-memory engine — closing the in-memory-only gap.
// The served policy is BOUND from the engine record (engine.getCandidate(id).policy) — server-sourced,
// never a caller-passed forgeable Policy. One tx = champion put + auto-loop audit + freq-cap stamp (so a
// half-write can't stamp-without-serving or serve-without-stamping). After commit: external Cloud Logging
// anchor (prereq #8) + engine.markAutoPromoted (durable-first, mirror of promoteToServing).
//
// Keep CHAMPION/ACTIVE_KEY in sync with widget-backend/champion.ts + control-plane/champion-promoter.ts.
const CHAMPION = "champion";
const ACTIVE_KEY = "active";

export interface AutoServingChampion {
  policy: Policy;
  promotedFrom?: string;
  promotedAt?: string;
  /** Always "auto-loop" — the auto path is never attributed to a human (NN #5, ADR-0014 inv #8). */
  approvedBy: "auto-loop";
}

/**
 * Persist an auto-promoted candidate to the active serving slot for `tenantId`. Refuses (no write) unless
 * the engine marks it autoPromotable, opt-in is enabled, no kill is armed, and the durable ledger shows
 * both stages complete.
 */
export async function serveAutoChampion(
  engine: EvolutionEngine,
  candidateId: string,
  store: RuntimeStatePort,
  tenantId: string,
  opts: { at?: string } = {},
): Promise<AutoServingChampion> {
  const at = opts.at ?? new Date().toISOString();
  // Guard 1 — engine markers (in-process, engine-enforced). First, before anything.
  const check = engine.autoPromotable(candidateId);
  if (!check.ok) throw new Error(`serveAutoChampion refused — not auto-promotable: ${check.reasons.join(", ")}`);
  const rec = engine.getCandidate(candidateId);
  if (!rec) throw new Error(`serveAutoChampion refused — unknown candidate ${candidateId}`);
  const policy = rec.policy; // server-sourced: bound from the engine record, never a caller-passed Policy
  const fromId = engine.getChampion().policy.id;

  // Guard 2 — opt-in gate + kill, fail-closed (defense in depth; serving re-checks the kill per turn).
  const gate = await readAutoPromoteEnabled(store, tenantId);
  if (!gate.enabled) throw new Error(`serveAutoChampion refused — auto-promote not enabled for ${tenantId}: ${gate.reason}`);
  const kill = await matchedKill(store, { tenantId, agentType: RUNTIME_AGENT_TYPE });
  if (kill) throw new Error(`serveAutoChampion refused — kill armed (scope "${kill.scope}")`);

  const cfg: AutoServingChampion = { policy, promotedFrom: fromId, promotedAt: at, approvedBy: "auto-loop" };
  const auditRec = await store.tx({ tenantId }, async (t) => {
    // Guard 3 (cross-process) — the durable ledger must show both stages complete, verified IN the tx so
    // even a separate process bypassing the in-memory engine can't reach serving.
    if (!autoStageComplete(await readAutoStageTx(t, candidateId))) {
      throw new Error(`serveAutoChampion refused — durable stage ledger incomplete for ${candidateId}`);
    }
    // Stamp the ≤1/week frequency cap ATOMICALLY with the champion write (no serve-without-stamp). Done
    // FIRST so the champion.auto_promote record below is the chain HEAD the external anchor pins.
    await recordAutoPromotionTx(t, tenantId, at);
    await t.put(CHAMPION, ACTIVE_KEY, cfg);
    return t.audit(
      {
        actor: "auto-loop", // NEVER "human" — the auto path is honestly attributed
        action: "champion.auto_promote",
        input: { tenantId, candidateId, policyId: policy.id, from: fromId },
        decision: `auto-promoted ${policy.id} to serving`,
        reversalPath: "rollbackServing / delayedRollbackToBaseline",
      },
      at,
    );
  });
  // Externally anchor the committed record (prereq #8): emit {seq, hash} to stdout → Cloud Logging.
  console.log(`AUDIT_ANCHOR ${JSON.stringify({ t: tenantId, seq: auditRec.seq, hash: auditRec.hash, at: auditRec.at })}`);
  // After-commit engine bookkeeping (durable-first; re-asserts autoPromotable + kill internally).
  engine.markAutoPromoted(candidateId);
  return cfg;
}
