import type { RuntimeStatePort } from "@palup/platform-ports";
import type { Policy } from "@palup/widget-brain";
import { matchedKill, RUNTIME_AGENT_TYPE, readAutoPromoteEnabled } from "@palup/state-postgres";

// ADR-0014 prereq #8 — the DURABLE, externally-anchored AUTO-promote write primitive. The T4 orchestrator
// calls this ONCE, AFTER every gate has passed (opt-in, cross-family gate, shadow, canary-with-power,
// change-class, kill), to persist an auto-promoted champion to serving. Distinct from the HUMAN path
// (champion-promoter.promoteToServing, which REFUSES an "auto-loop" approver): this is the auto path, so
// it is attributed to actor "auto-loop", NEVER "human".
//
// Three properties this primitive must hold (verified by auto-champion-write.test.ts):
//   • ATOMIC + anchored: the champion put, the auto-loop audit entry, and the trusted head-anchor advance
//     commit in ONE store.tx — so an audit/anchor failure rolls back the champion put (no half-write), and
//     the persisted anchor lets verifyAudit(expectedHead) detect tail-truncation/rewrite the in-chain
//     check alone can't (prereq #8 "externally-anchored, committed atomically with the champion write").
//   • FAIL-CLOSED dormancy defense: refuses with NO write unless the T1 opt-in gate is enabled (per-tenant
//     opt-in AND platform override on) AND no kill is armed on the shared 3-scope registry. This is
//     defense in depth on top of the orchestrator's own checks — the write itself never trusts the caller.
//   • CONTAINMENT: writes a Policy only (styleDirective + proactivityDefault; guardrails live in code), to
//     the SAME serving slot the human path and serving read use.
//
// Keep CHAMPION/ACTIVE_KEY in sync with widget-backend/champion.ts + control-plane/champion-promoter.ts.
const CHAMPION = "champion";
const ACTIVE_KEY = "active";
// The trusted head anchor — a per-tenant {seq, hash} the audit chain is verified against. Kept in its own
// collection so it is never confused with the serving champion.
const ANCHOR = "audit-anchor";
const ANCHOR_KEY = "head";

export interface AutoServingChampion {
  policy: Policy;
  promotedFrom?: string;
  promotedAt?: string;
  /** Always "auto-loop" — the auto path is never attributed to a human (NN #5, ADR-0014 inv #8). */
  approvedBy: "auto-loop";
}

export interface AuditAnchor {
  seq: number;
  hash: string;
}

/** The persisted trusted head anchor for this tenant's audit chain, or null if none yet. */
export async function readAuditAnchor(store: RuntimeStatePort, tenantId: string): Promise<AuditAnchor | null> {
  return (await store.get<AuditAnchor>({ tenantId }, ANCHOR, ANCHOR_KEY)) ?? null;
}

/** Verify the tenant's audit chain against the persisted head anchor — detects tail-truncation / rewrite
 * the in-chain recompute alone cannot (prereq #8). Falls back to a plain chain check if no anchor yet. */
export async function verifyAutoChampionAudit(store: RuntimeStatePort, tenantId: string): Promise<{ ok: boolean; brokenAt?: number }> {
  const anchor = await readAuditAnchor(store, tenantId);
  return store.verifyAudit({ tenantId }, anchor ? { expectedHead: anchor } : undefined);
}

/**
 * Persist an AUTO-promoted champion to the active serving slot for `tenantId`, atomically with an
 * auto-loop audit entry and a head-anchor advance. Fails closed (no write) unless auto-promote is enabled
 * for the tenant AND no kill is armed.
 */
export async function writeAutoChampion(
  store: RuntimeStatePort,
  tenantId: string,
  policy: Policy,
  opts: { promotedFrom?: string; at?: string } = {},
): Promise<AutoServingChampion> {
  const at = opts.at ?? new Date().toISOString();
  // Fail-closed guards BEFORE any write (defense in depth — the orchestrator checks these too).
  const gate = await readAutoPromoteEnabled(store, tenantId);
  if (!gate.enabled) throw new Error(`auto-champion write refused — auto-promote not enabled for ${tenantId}: ${gate.reason}`);
  const kill = await matchedKill(store, { tenantId, agentType: RUNTIME_AGENT_TYPE });
  if (kill) throw new Error(`auto-champion write refused — kill armed (scope "${kill.scope}")`);

  const cfg: AutoServingChampion = { policy, promotedFrom: opts.promotedFrom, promotedAt: at, approvedBy: "auto-loop" };
  await store.tx({ tenantId }, async (t) => {
    await t.put(CHAMPION, ACTIVE_KEY, cfg);
    const rec = await t.audit(
      {
        actor: "auto-loop", // NEVER "human" — the auto path is honestly attributed
        action: "champion.auto_promote",
        input: { tenantId, policyId: policy.id, from: opts.promotedFrom },
        decision: `auto-promoted ${policy.id} to serving`,
        reversalPath: "rollbackServing / delayedRollbackToBaseline",
      },
      at,
    );
    // Advance the trusted head anchor to the just-committed record, IN THE SAME TX (atomic with the write).
    await t.put(ANCHOR, ANCHOR_KEY, { seq: rec.seq, hash: rec.hash });
  });
  return cfg;
}
