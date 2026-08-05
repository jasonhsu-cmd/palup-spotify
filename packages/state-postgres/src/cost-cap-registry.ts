import type { RuntimeStatePort } from "@palup/platform-ports";

// Basic-mode-at-cap (§8a invariant 14) — the serving-side half of the cost circuit-breaker.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THE SPEC ASKS FOR. `docs/design/shopper-widget.md:210`:
//
//   | 14 | Basic-mode-at-cap | at billing cap | no proactive; live chat continues; customer never sees
//        billing state | compliance |
//
// and `docs/AGENT-GOVERNANCE.md:114`: "Cost circuit-breaker: spend beyond budget freezes the agent and
// raises an alert."
//
// WHAT EXISTED BEFORE THIS FILE: nothing. Searched all of packages/ for atCap / basicMode / billingCap /
// at_cap — zero non-test hits — and the 66-case eval corpus contained no case mentioning a cap. Spend IS
// measured, but only in the control plane (`deriveCostUsd(rollup, loadModelPrices())`,
// control-plane/src/server.ts), and nothing turned that into a signal the serving path could read.
//
// WHY A SHARED REGISTRY AND NOT A PER-REQUEST COST QUERY. Modelled deliberately on the run-time kill
// registry next door, for the same reasons and with the same shape:
//   * it must PROPAGATE across every serving instance (Cloud Run scales horizontally; a per-instance
//     boolean is exactly the bug the kill switch already had and had to be fixed for);
//   * serving reads it once per turn, so it has to be one cheap store read, not a telemetry rollup;
//   * the DECISION belongs where spend is measured (the control plane), not in the request path.
//
// DIRECTION OF SAFETY. Entering basic mode is a pure RESTRICTION — it removes proactive/outbound
// behaviour and cannot spend money, so it is safe to set automatically (that is what a circuit-breaker
// is). LEAVING it restores autonomy, so `clearCostCap` is written as a deliberate operator action and
// audited as one. Adjusting the COGS cap itself is a Policy change and stays human-gated
// (`docs/design/cost-margin-telemetry.md:21`) — that decision is NOT made here; this registry only
// records that a cap was reached.
//
// WHAT THIS IS NOT. It is NOT the kill switch. A kill halts the agent entirely and escalates. At cap the
// shopper must keep being served — "live chat continues" — because a merchant's billing state is not the
// shopper's problem and must never be visible to them. Keeping the two registries separate keeps that
// difference explicit rather than overloading one flag with two very different meanings.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Cap scope. `global` is the platform COGS cap; `tenant:<id>` is one merchant's own plan cap. */
export type CostCapScope = "global" | `tenant:${string}`;

export interface CostCapEntry {
  scope: CostCapScope;
  /** Free text for the operator/audit trail. NEVER rendered to a shopper. */
  reason: string;
  at: string;
}

const SYSTEM = { tenantId: "__system__" };
const CAP = "cost_cap"; // KV collection under the reserved system tenant

/**
 * Is this tenant at cap? Precedence global > tenant, mirroring `matchedKill`: the platform cap binds
 * every merchant. One store read.
 */
export async function matchedCostCap(
  store: RuntimeStatePort,
  id: { tenantId?: string },
): Promise<CostCapEntry | null> {
  const byScope = new Map((await store.list<CostCapEntry>(SYSTEM, CAP)).map((r) => [r.key, r.value]));
  const wants: CostCapScope[] = ["global"];
  if (id.tenantId) wants.push(`tenant:${id.tenantId}`);
  for (const w of wants) {
    const e = byScope.get(w);
    if (e) return e;
  }
  return null;
}

/**
 * Record that a scope has reached its cap (idempotent). Audited atomically with the write, like every
 * other governed action (NN#5). Safe to call automatically: it can only REMOVE autonomy.
 */
export async function setCostCap(
  store: RuntimeStatePort,
  scope: CostCapScope,
  reason = "cost cap reached",
  at = new Date().toISOString(),
  actor = "cost-circuit-breaker",
): Promise<void> {
  await store.tx(SYSTEM, async (t) => {
    await t.put(CAP, scope, { scope, reason, at });
    await t.audit(
      {
        actor,
        action: "cost_cap.set",
        input: { scope, reason },
        decision: "basic_mode",
        // The CLI is named FIRST because it is the path that WORKS against the current deployment:
        // deploy-staging.yml deploys only `palup-widget-staging` and no workflow deploys the control
        // plane, so the HTTP route below is the operator console for when that service exists. Naming
        // only the route — as this originally did — repeated the exact defect #166 fixed for the kill
        // switch: a reversal path in an immutable record has to be one an operator can actually RUN
        // (NN#5), and reachable-in-the-repo is not reachable-in-production.
        reversalPath: "pnpm cap:clear --scope <scope> | POST /api/cost-cap/clear",
      },
      at,
    );
  });
}

/**
 * Operator action: lift the cap for one scope, or all scopes when omitted. This RESTORES autonomy, so it
 * is deliberately an explicit operator action attributed to a named operator rather than something the
 * breaker can undo for itself.
 */
export async function clearCostCap(
  store: RuntimeStatePort,
  scope?: CostCapScope,
  at = new Date().toISOString(),
  actor = "operator",
): Promise<void> {
  const scopes = scope
    ? [scope]
    : (await store.list<CostCapEntry>(SYSTEM, CAP)).map((r) => r.key as CostCapScope);
  await store.tx(SYSTEM, async (t) => {
    for (const s of scopes) await t.delete(CAP, s);
    await t.audit(
      {
        actor,
        action: "cost_cap.clear",
        input: { scope: scope ?? "all" },
        decision: "cleared",
        reversalPath: "pnpm cap:set --scope <scope> | POST /api/cost-cap",
      },
      at,
    );
  });
}

/** Current capped scopes (operator status / dashboard). */
export async function costCapStatus(store: RuntimeStatePort): Promise<CostCapEntry[]> {
  return (await store.list<CostCapEntry>(SYSTEM, CAP)).map((r) => r.value);
}
