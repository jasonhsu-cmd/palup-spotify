import type { RuntimeStatePort } from "@palup/platform-ports";

// Run-time operator Kill Switch (governance non-negotiable #4) — backed by the shared RuntimeStatePort
// so an operator halt PROPAGATES across every serving instance (it was previously a per-instance local
// file the deployed backend never re-read; that could not halt a live agent). Still distinct from the
// build-time evolution kill switch, which only halts candidate promotions.
//
// The registry lives under a reserved SYSTEM tenant: a global or agent-type kill is cross-tenant
// operator state, so it can't live inside one merchant's partition; a tenant-scoped kill keys by
// `tenant:<id>`. Arming/disarming is written INSIDE a transaction together with its immutable audit
// record (NN #5) so the action and its audit commit atomically.

export type KillScope = "global" | `tenant:${string}` | `agent:${string}`;
export interface KillEntry {
  scope: KillScope;
  reason: string;
  at: string;
}

/**
 * The run-time agent-type of the live shopper agent — the SINGLE source of truth shared by the serving
 * backend (widget-backend reads matchedKill per turn) and the evolution PROMOTION path (control-plane),
 * so both check the SAME agent-type against this kill registry. If these two drifted, an operator kill
 * armed at the `agent:shopper` scope would halt serving but NOT halt a promotion pushing new behavior to
 * that agent — the exact gap this closes (governance NN #4, ADR-0014). Widen to a small registry when a
 * second run-time agent-type ships.
 */
export const RUNTIME_AGENT_TYPE = "shopper";

const SYSTEM = { tenantId: "__system__" };
const KILL = "kill"; // KV collection under the system tenant

/**
 * The matching kill entry for this agent, or null if it is not halted. Precedence: global > tenant >
 * agent-type — a global kill halts everything. One store read (the registry is small).
 */
export async function matchedKill(
  store: RuntimeStatePort,
  id: { tenantId?: string; agentType?: string },
): Promise<KillEntry | null> {
  const byScope = new Map((await store.list<KillEntry>(SYSTEM, KILL)).map((r) => [r.key, r.value]));
  const wants: KillScope[] = ["global"];
  if (id.tenantId) wants.push(`tenant:${id.tenantId}`);
  if (id.agentType) wants.push(`agent:${id.agentType}`);
  for (const w of wants) {
    const e = byScope.get(w);
    if (e) return e;
  }
  return null;
}

/** Operator action: arm a kill for a scope (idempotent). Audited atomically with the write. */
export async function armKill(
  store: RuntimeStatePort,
  scope: KillScope,
  reason = "operator",
  at = new Date().toISOString(),
): Promise<void> {
  await store.tx(SYSTEM, async (t) => {
    await t.put(KILL, scope, { scope, reason, at });
    await t.audit(
      {
        actor: "operator",
        action: "runtime_kill.arm",
        input: { scope, reason },
        decision: "armed",
        // The CLI is named FIRST because it is the path that works against the current deployment: the
        // control-plane routes are the operator console for when that service is deployed, and this repo
        // deploys only the widget backend. A reversal path in an immutable record has to be one an
        // operator can actually run (NN #5) — see widget-backend/src/jobs/kill-switch.ts.
        reversalPath: "pnpm kill:disarm --scope <scope> | POST /api/runtime-unkill",
      },
      at,
    );
  });
}

/** Operator action: disarm one scope, or ALL scopes when omitted. Audited atomically. */
export async function disarmKill(
  store: RuntimeStatePort,
  scope?: KillScope,
  at = new Date().toISOString(),
): Promise<void> {
  const scopes = scope
    ? [scope]
    : (await store.list<KillEntry>(SYSTEM, KILL)).map((r) => r.key as KillScope);
  await store.tx(SYSTEM, async (t) => {
    for (const s of scopes) await t.delete(KILL, s);
    await t.audit(
      {
        actor: "operator",
        action: "runtime_kill.disarm",
        input: { scope: scope ?? "all" },
        decision: "disarmed",
        reversalPath: "pnpm kill:arm --scope <scope> | POST /api/runtime-kill",
      },
      at,
    );
  });
}

/** Current armed scopes (operator status / dashboard). */
export async function killStatus(store: RuntimeStatePort): Promise<KillEntry[]> {
  return (await store.list<KillEntry>(SYSTEM, KILL)).map((r) => r.value);
}
