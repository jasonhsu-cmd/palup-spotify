import { describe, expect, it } from "vitest";
import type { AuditRecord } from "@palup/platform-ports";
import { buildOrderTouchpoints, orderRefOf, ORDER_TOUCHPOINT_ACTIONS } from "../src/orders/touchpoints.js";

const rec = (over: Partial<AuditRecord>): AuditRecord => ({
  seq: 1, at: "2026-08-20T00:00:00Z", actor: "agent:wb", action: "agent.action.auto",
  prevHash: "0".repeat(64), hash: "h", ...over,
});

describe("order touchpoints read model", () => {
  it("extracts orderRef from input.action.params.orderId only", () => {
    const r = rec({ input: { action: { type: "issue_refund", params: { orderId: "1001" } } } });
    expect(orderRefOf(r)).toBe("1001");
  });

  it("returns undefined when no order id is present (never fabricates one)", () => {
    expect(orderRefOf(rec({ input: { action: { type: "send_campaign", params: {} } } }))).toBeUndefined();
    expect(orderRefOf(rec({ input: {} }))).toBeUndefined();
    expect(orderRefOf(rec({ input: undefined }))).toBeUndefined();
    expect(orderRefOf(rec({ input: { action: { params: { orderId: 5 } } } }))).toBeUndefined(); // non-string
  });

  it("groups only ALLOWLISTED, order-linked actions by orderRef, newest-first", () => {
    const records: AuditRecord[] = [
      rec({ seq: 1, action: "agent.action.auto", input: { action: { params: { orderId: "1001" } } } }),
      rec({ seq: 2, action: "proposal.created", input: { action: { params: { orderId: "1001" } } } }), // not allowlisted
      rec({ seq: 3, action: "proposal.executed", input: { action: { params: { orderId: "1001" } } } }),
      rec({ seq: 4, action: "agent.action.auto", input: { action: { params: {} } } }),               // no orderRef
    ];
    const map = buildOrderTouchpoints(records);
    expect(map.get("1001")!.map((t) => t.seq)).toEqual([3, 1]); // newest-first, allowlisted only
    expect(map.size).toBe(1);
  });

  it("the allowlist excludes proposal.created (an unexecuted proposal is not a touchpoint on the order)", () => {
    expect(ORDER_TOUCHPOINT_ACTIONS.has("proposal.created")).toBe(false);
    expect(ORDER_TOUCHPOINT_ACTIONS.has("agent.action.auto")).toBe(true);
    expect(ORDER_TOUCHPOINT_ACTIONS.has("proposal.executed")).toBe(true);
  });
});
