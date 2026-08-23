// Kill-Switch enforcement (governance non-negotiable #4) — thin, merchant-scoped wrappers over the
// SHARED run-time kill registry in `@palup/state-postgres` (`runtime-kill-registry.ts`). This is
// deliberately NOT a second kill mechanism: it reuses the same `armKill`/`disarmKill`/`matchedKill`
// the serving widget-backend and the evolution promotion path already check, scoped by
// `KillScope = \`tenant:${tenantId}\`` so one merchant's halt can never leak into another's. A
// global or agent-type-scoped kill (armed directly via the shared registry) still matches through
// `assertNotKilled` — precedence is global > tenant > agent-type, exactly as `matchedKill` defines.

import type { RuntimeStateCtx, RuntimeStatePort } from "@palup/platform-ports";
import { armKill, disarmKill, matchedKill, type KillEntry, type KillScope } from "@palup/state-postgres";

/** Thrown by `assertNotKilled` when a matching kill entry (global, this tenant, or this agent-type)
 * is armed. Carries the matched entry so callers can log/return the operator's reason. */
export class KillSwitchError extends Error {
  constructor(public readonly entry: KillEntry) {
    super(`kill switch armed (scope=${entry.scope}): ${entry.reason}`);
    this.name = "KillSwitchError";
  }
}

function tenantScope(ctx: RuntimeStateCtx): KillScope {
  return `tenant:${ctx.tenantId}`;
}

/** Operator action: halt one merchant. Arm+audit are atomic inside `armKill` itself. */
export async function killMerchant(
  state: RuntimeStatePort,
  ctx: RuntimeStateCtx,
  reason: string,
  at?: string,
): Promise<void> {
  await armKill(state, tenantScope(ctx), reason, at);
}

/** Operator action: resume one merchant. Disarm+audit are atomic inside `disarmKill` itself. */
export async function unkillMerchant(state: RuntimeStatePort, ctx: RuntimeStateCtx, at?: string): Promise<void> {
  await disarmKill(state, tenantScope(ctx), at);
}

/** The matching kill entry for this merchant (global or tenant-scoped), or `null` if clear —
 * for an operator status surface, not a gate itself (see `assertNotKilled`). */
export async function merchantKillStatus(state: RuntimeStatePort, ctx: RuntimeStateCtx): Promise<KillEntry | null> {
  return matchedKill(state, { tenantId: ctx.tenantId });
}

/**
 * The kill-switch gate. MUST be called before any execution (`proposeOrExecute`'s auto branch,
 * `executeApproved`) — never after. Throws `KillSwitchError` if a global, this-tenant, or
 * this-agent-type kill is armed; resolves silently otherwise.
 */
export async function assertNotKilled(
  state: RuntimeStatePort,
  ctx: RuntimeStateCtx,
  agentType?: string,
): Promise<void> {
  const match = await matchedKill(state, { tenantId: ctx.tenantId, agentType });
  if (match) throw new KillSwitchError(match);
}
