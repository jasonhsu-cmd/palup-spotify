import type { AuditRecord } from "@palup/platform-ports";

// W5 — the per-order "agent touchpoints" read model (spec §9 W5). Same discipline as W2's
// routes/activity.ts: an ALLOWLIST read model over the tenant's audit log, honest by construction.
// The ONE narrow difference is that a per-order JOIN needs a key, so `orderRefOf` reads exactly one
// scalar — `input.action.params.orderId` — and nothing else from `input`. Because no agent action
// currently writes an `orderId` param, this returns an empty map today (every order shows "no agent
// activity yet") and lights up automatically once an order-scoped agent action is audited.
//
// DISTINCT FROM incremental: a touchpoint is per-order FACTUAL (what the agent did on this specific
// order) — never aggregate/billed $ or attributed revenue. No dollar figure belongs in this file.

/** The audited actions that COUNT as a factual touchpoint on an order. An EXECUTED auto-action or an
 * executed proposal is a real thing the agent did; a merely-CREATED proposal is not (it may be
 * rejected/expired), so it is deliberately excluded — mirroring activity.ts's allowlist stance. */
export const ORDER_TOUCHPOINT_ACTIONS: ReadonlySet<string> = new Set(["agent.action.auto", "proposal.executed"]);

export interface OrderTouchpoint {
  orderRef: string;
  seq: number;
  at: string;
  actor: string;
  action: string;
}

/** The single allowlisted projection from the audit `input`: `input.action.params.orderId` when it
 * is a non-empty string, else undefined. Never reads any other `input` field (input is typed
 * `unknown`, written by ~50 sites — this is the one deliberate, narrow read, not a general opening). */
export function orderRefOf(record: AuditRecord): string | undefined {
  const input = record.input as { action?: { params?: Record<string, unknown> } } | undefined;
  const orderId = input?.action?.params?.orderId;
  return typeof orderId === "string" && orderId.length > 0 ? orderId : undefined;
}

/** Groups allowlisted, order-linked audit records by orderRef, newest-first within each order. */
export function buildOrderTouchpoints(records: AuditRecord[]): Map<string, OrderTouchpoint[]> {
  const byOrder = new Map<string, OrderTouchpoint[]>();
  for (const r of records) {
    if (!ORDER_TOUCHPOINT_ACTIONS.has(r.action)) continue;
    const orderRef = orderRefOf(r);
    if (orderRef === undefined) continue;
    const list = byOrder.get(orderRef) ?? [];
    list.push({ orderRef, seq: r.seq, at: r.at, actor: r.actor, action: r.action });
    byOrder.set(orderRef, list);
  }
  for (const list of byOrder.values()) list.sort((a, b) => b.seq - a.seq); // newest-first
  return byOrder;
}
