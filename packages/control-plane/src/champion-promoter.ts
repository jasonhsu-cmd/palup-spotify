import type { RuntimeStatePort } from "@palup/platform-ports";
import type { Policy } from "@palup/widget-brain";
import type { Champion, EvolutionEngine } from "@palup/evolution";
import { matchedKill, RUNTIME_AGENT_TYPE, freezeAutoPromote, AUTO_PROMOTE_WINDOW_MS } from "@palup/state-postgres";

// The control-plane WRITE half of promote→serving (the READ half is widget-backend/champion.ts). A
// HUMAN-approved, gate-passed promotion is persisted to the SHARED RuntimeStatePort so EVERY serving
// instance picks up the new champion (ADR-0003: propose→…→approve→promote→monitor). This closes the gap
// where engine.promote only updated the engine's IN-MEMORY champion while serving kept using
// DEFAULT_POLICY — a promoted policy never actually reached shoppers.
//
// Governance properties this file must hold (verified by champion-promoter.test.ts):
//   • NO self-deployment (NN #2): the candidate must be HUMAN-approved — status "approved" AND
//     approvedBy is a human (NOT "auto-loop"). "approved" alone is autonomy-agnostic (engine.approve
//     accepts an "auto-loop" approver), so this path positively verifies the recorded approver and
//     REFUSES an automated approval. The audit actor is bound to that recorded approver, never a
//     caller-supplied string.
//   • Kill switch (NN #4): fails closed on the SHARED three-scope run-time kill registry
//     (matchedKill global>tenant>agent), not just the engine's in-process boolean — an operator kill
//     halts promotion to serving even if the engine's own flag wasn't armed (ADR-0014 prereq #1).
//   • Durable-first ordering: the engine is NOT mutated until the serving store write COMMITS. On a
//     store fault the engine is untouched, so a retry is clean and (critically for rollback) the
//     prevChampion is never stranded null while serving still holds a bad champion.
//   • Containment: what is served is a Policy (styleDirective + proactivityDefault only; guardrails live
//     in code — widget-brain types.ts), so a promoted champion can never loosen a deterministic guardrail.
//
// PRECONDITION (H3): `engine` MUST be the evolution engine that governs THIS `tenantId`. The engine's
// champion/prevChampion are its global in-memory state; passing a mismatched (engine, tenantId) would
// write one tenant's policy into another's serving slot. Single-tenant today (RUNTIME_TENANT); a
// per-tenant engine binding is required before multi-tenant auto-optimize (ADR-0014).
//
// Keep CHAMPION/ACTIVE_KEY in sync with widget-backend/champion.ts (same collection/key, keyed PER
// SERVING TENANT — a promotion for one merchant never serves another merchant's shoppers).
const CHAMPION = "champion";
const ACTIVE_KEY = "active";

export interface ServingChampion {
  policy: Policy;
  /** Prior champion policy id this replaced (audit trail); undefined for the first promotion. */
  promotedFrom?: string;
  promotedAt?: string;
  /** The human approver of record (bound from the engine's CandidateRecord, never caller free-text). */
  approvedBy?: string;
}

/** Read the active serving champion the control plane persisted (tooling/tests; serving itself reads via
 * widget-backend/champion.ts). Null until the first promotion ⇒ serving falls back to DEFAULT_POLICY. */
export async function servingChampion(store: RuntimeStatePort, tenantId: string): Promise<ServingChampion | null> {
  return (await store.get<ServingChampion>({ tenantId }, CHAMPION, ACTIVE_KEY)) ?? null;
}

/**
 * Promote a HUMAN-APPROVED candidate to the ACTIVE serving champion for `tenantId`. Verifies (without
 * mutating the engine) that the candidate is gate-passed + human-approved and that no kill is armed on
 * the shared registry, persists it to serving (put + audit in ONE tx, NN #5), and only THEN advances the
 * engine — so a store fault leaves both the engine and serving on the prior, safe champion.
 */
export async function promoteToServing(
  engine: EvolutionEngine,
  candidateId: string,
  store: RuntimeStatePort,
  tenantId: string,
  at = new Date().toISOString(),
): Promise<Champion> {
  // NN #4 — fail closed on the SHARED three-scope kill registry (not just engine.isKilled()).
  const kill = await matchedKill(store, { tenantId, agentType: RUNTIME_AGENT_TYPE });
  if (kill) throw new Error(`kill switch armed (${kill.scope}) — promotion to serving halted`);
  if (engine.isKilled()) throw new Error("engine kill switch is ON — promotion to serving halted");
  // NN #2 — read-only verification: gate-passed, human-approved. "approved" alone is not enough.
  const rec = engine.getCandidate(candidateId);
  if (!rec) throw new Error(`unknown candidate: ${candidateId}`);
  if (rec.status !== "approved") throw new Error(`cannot promote ${candidateId} in status ${rec.status} (needs human approval)`);
  if (rec.automated || !rec.approvedBy || rec.approvedBy === "auto-loop") {
    throw new Error(`${candidateId} was not HUMAN-approved (approver=${rec.approvedBy ?? "none"}) — the human promote→serving path refuses an automated approval`);
  }
  const fromId = engine.getChampion().policy.id;
  const cfg: ServingChampion = { policy: rec.policy, promotedFrom: fromId, promotedAt: at, approvedBy: rec.approvedBy };
  // Durable serving write FIRST (put + audit atomically). Engine untouched until this commits.
  await store.tx({ tenantId }, async (t) => {
    await t.put(CHAMPION, ACTIVE_KEY, cfg);
    await t.audit(
      {
        actor: rec.approvedBy, // the recorded HUMAN approver, never a caller-supplied string
        action: "champion.promote",
        input: { tenantId, candidateId, from: fromId, to: rec.policy.id },
        decision: `promoted ${rec.policy.id} to serving`,
        reversalPath: "rollbackServing",
      },
      at,
    );
  });
  // Advance the engine AFTER the durable serving write. Every throwing precondition was checked above, so
  // this transition succeeds; if it somehow didn't, serving already holds the (approved) champion.
  return engine.promote(candidateId);
}

/**
 * ADR-0014 #4 — write a guardrail-gated AUTO-promoted champion to serving. The auto-loop enforces every
 * auto-promote gate (kill / cross-family / floor / counter-metrics / holdout / cap+freeze / change-class)
 * BEFORE it calls this, so there is no human-approval check here — but we RE-CHECK the shared kill
 * registry (fail-closed, defense-in-depth against a kill armed mid-run) and write the serving champion +
 * audit atomically, attributed to "auto-loop" (never masquerading as a human, NN #5). Called serve-first
 * by the auto-loop, so a kill here leaves the engine unadvanced too.
 */
export async function serveAutoChampion(store: RuntimeStatePort, tenantId: string, champion: Champion, at = new Date().toISOString()): Promise<void> {
  const kill = await matchedKill(store, { tenantId, agentType: RUNTIME_AGENT_TYPE });
  if (kill) throw new Error(`kill switch armed (${kill.scope}) — auto-promotion to serving halted`);
  const fromId = (await servingChampion(store, tenantId))?.policy.id ?? "default";
  await store.tx({ tenantId }, async (t) => {
    await t.put(CHAMPION, ACTIVE_KEY, { policy: champion.policy, promotedFrom: fromId, promotedAt: at, approvedBy: "auto-loop" });
    await t.audit(
      {
        actor: "auto-loop",
        action: "champion.auto_promote",
        input: { tenantId, from: fromId, to: champion.policy.id },
        decision: `auto-promoted ${champion.policy.id} to serving (guardrail-gated)`,
        reversalPath: "rollbackServing",
      },
      at,
    );
  });
}

/**
 * Roll the serving champion back to the previous one — the serving half of the monitor's auto-rollback
 * (ADR-0003). Persists the restored champion to serving BEFORE calling engine.rollback(), so a store
 * fault leaves prevChampion intact (a retry can recover) instead of stranding it null while serving
 * still holds the regressing champion.
 */
export async function rollbackServing(
  engine: EvolutionEngine,
  store: RuntimeStatePort,
  tenantId: string,
  reason: string,
  at = new Date().toISOString(),
): Promise<Champion> {
  const prev = engine.getPreviousChampion();
  if (!prev) throw new Error("no previous champion to roll back to");
  const badId = engine.getChampion().policy.id;
  const cfg: ServingChampion = { policy: prev.policy, promotedFrom: badId, promotedAt: at };
  // Durable revert FIRST — serving returns to the prior champion regardless of engine state.
  await store.tx({ tenantId }, async (t) => {
    await t.put(CHAMPION, ACTIVE_KEY, cfg);
    await t.audit(
      {
        actor: "monitor",
        action: "champion.rollback",
        input: { tenantId, from: badId, to: prev.policy.id, reason },
        decision: `rolled back serving to ${prev.policy.id}`,
        reversalPath: "promoteToServing",
      },
      at,
    );
  });
  const restored = engine.rollback(reason); // advance the engine AFTER the durable revert
  // ADR-0014 #9 — a monitored regression FREEZES the auto-promote fast-lane so the same/similar change
  // can't be immediately re-promoted (the next auto-loop run reads this on the shared registry). Best-
  // effort on top of the revert: the per-merchant frequency cap still bounds drift even if this races.
  const nowMs = Date.parse(at);
  const until = Number.isNaN(nowMs) ? at : new Date(nowMs + AUTO_PROMOTE_WINDOW_MS).toISOString();
  await freezeAutoPromote(store, tenantId, until, `rollback: ${reason}`, at);
  return restored;
}
