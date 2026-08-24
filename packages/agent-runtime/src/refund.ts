import type { Executor } from "./loop.js";
import type { RefundPort } from "@palup/platform-ports";

// W5 — the refund executor. The ONLY place a refund side-effect runs, and only reachable via the W1
// loop: `proposeOrExecute` auto-executes it when the action is within PALUP_FLOORS.refund AND the
// merchant's rules allow it (tiny in-policy goodwill), otherwise a pending Proposal is created and
// this runs only from `executeApproved` post human-approval. Params carry `usd` so the classifier's
// refund floor/dimension logic governs auto-eligibility.

/** The AgentAction.type a refund carries — the key `resolveExecutor` (engine-wiring) maps to here. */
export const REFUND_ACTION_TYPE = "issue_refund";

/** Dedicated agent type for the refund desk — NEVER "service"/"win_back" — so an operator can arm a
 *  TYPE-SCOPED Kill on the one money-moving agent (this executor's audit/attribution uses it). */
export const REFUND_AGENT_TYPE = "refund_desk";

function reqStr(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  if (typeof v !== "string" || v.length === 0) throw new Error(`refundExecutor: action.params.${key} must be a non-empty string`);
  return v;
}

function reqNum(params: Record<string, unknown>, key: string): number {
  const v = params[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`refundExecutor: action.params.${key} must be a number`);
  return v;
}

/** The executor the W1 loop runs — auto (within `PALUP_FLOORS.refund`) or post human-approval. It does
 *  NOT decide governance itself; it only calls the injected `RefundPort` for an action the loop has
 *  already classified/approved, and returns the port's result as an `ExecutionResult`. Fails closed:
 *  a malformed action (missing `orderRef`/`usd`) throws rather than issuing anything. */
export function refundExecutor(port: RefundPort): Executor {
  return async (input) => {
    const params = input.action.params;
    const orderRef = reqStr(params, "orderRef");
    const amountUsd = reqNum(params, "usd");
    const reason = typeof params.reason === "string" ? params.reason : "goodwill";
    const result = await port.issueRefund(input.ctx, { orderRef, amountUsd, reason });
    return { ok: result.ok, detail: result.detail };
  };
}
