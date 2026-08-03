import type { RuntimeStatePort } from "@palup/platform-ports";
import type { Policy } from "@palup/widget-brain";
import { matchedKill, RUNTIME_AGENT_TYPE, readAutoPromoteEnabled } from "@palup/state-postgres";

// ADR-0014 prereq #8 — the DURABLE, externally-anchored AUTO-promote write primitive. The T4 orchestrator
// calls this ONCE, AFTER every gate has passed (opt-in, cross-family gate, shadow, canary-with-power,
// change-class, kill), to persist an auto-promoted champion to serving. Distinct from the HUMAN path
// (champion-promoter.promoteToServing, which REFUSES an "auto-loop" approver): this is the auto path, so
// it is attributed to actor "auto-loop", NEVER "human".
//
// Properties this primitive holds (verified by auto-champion-write.test.ts):
//   • ATOMIC: the champion put + the auto-loop audit entry commit in ONE store.tx — an audit failure
//     rolls back the champion put (no half-write).
//   • EXTERNALLY ANCHORED (prereq #8): after commit, the audit record's {seq, hash} is emitted to stdout
//     → Cloud Logging (`AUDIT_ANCHOR …`), OUTSIDE the DB's mutable surface — the SAME mechanism the widget
//     backend uses for shopper-turn audits (widget-backend/server.ts "#19 head-anchor"). A store-level
//     rewrite / tail-truncation is caught by reconciling the DB chain against these external anchors,
//     which a compromised DBA has no write path to. (An in-DB anchor row would be useless here: the audit
//     chain is per-tenant and shared by many writers, so a champion-only in-DB {seq,hash} both goes stale
//     the instant any other entry lands AND lives in the same trust domain it is meant to guard.)
//   • FAIL-CLOSED dormancy defense: refuses with NO write unless the T1 opt-in gate is enabled (per-tenant
//     opt-in AND platform override on) AND no kill is armed on the shared 3-scope registry. These run
//     immediately BEFORE the write as defense in depth; they are NOT a substitute for the always-on kill
//     enforcement, which is serving's per-turn matchedKill (a champion written during a kill race sits
//     inert while killed). A cross-tenant atomic re-check is not possible from a single-tenant write tx
//     (the kill registry lives in the __system__ partition); the definitive pre-serve re-check is the T4
//     orchestrator's + serving's job, not this write's.
//   • CONTAINMENT: writes a Policy only (styleDirective + proactivityDefault; guardrails live in code), to
//     the SAME serving slot the human path and serving read use.
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
 * Persist an AUTO-promoted champion to the active serving slot for `tenantId`, atomically with an
 * auto-loop audit entry, then emit the external Cloud Logging anchor. Fails closed (no write) unless
 * auto-promote is enabled for the tenant AND no kill is armed.
 */
export async function writeAutoChampion(
  store: RuntimeStatePort,
  tenantId: string,
  policy: Policy,
  opts: { promotedFrom?: string; at?: string } = {},
): Promise<AutoServingChampion> {
  const at = opts.at ?? new Date().toISOString();
  // Fail-closed guards BEFORE any write (defense in depth — the orchestrator + serving check these too).
  const gate = await readAutoPromoteEnabled(store, tenantId);
  if (!gate.enabled) throw new Error(`auto-champion write refused — auto-promote not enabled for ${tenantId}: ${gate.reason}`);
  const kill = await matchedKill(store, { tenantId, agentType: RUNTIME_AGENT_TYPE });
  if (kill) throw new Error(`auto-champion write refused — kill armed (scope "${kill.scope}")`);

  const cfg: AutoServingChampion = { policy, promotedFrom: opts.promotedFrom, promotedAt: at, approvedBy: "auto-loop" };
  const rec = await store.tx({ tenantId }, async (t) => {
    await t.put(CHAMPION, ACTIVE_KEY, cfg);
    return t.audit(
      {
        actor: "auto-loop", // NEVER "human" — the auto path is honestly attributed
        action: "champion.auto_promote",
        input: { tenantId, policyId: policy.id, from: opts.promotedFrom },
        decision: `auto-promoted ${policy.id} to serving`,
        reversalPath: "rollbackServing / delayedRollbackToBaseline",
      },
      at,
    );
  });
  // Externally anchor the committed record (prereq #8): emit {seq, hash} to stdout → Cloud Logging, the
  // same PII-safe head-anchor the widget backend uses. This is the trust domain a store-level rewrite
  // cannot reach; reconciliation against these lines is what detects truncation/rewrite.
  console.log(`AUDIT_ANCHOR ${JSON.stringify({ t: tenantId, seq: rec.seq, hash: rec.hash, at: rec.at })}`);
  return cfg;
}
