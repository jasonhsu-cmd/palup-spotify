import { describe, expect, it } from "vitest";
import { SandboxRefundAdapter } from "@palup/platform-ports";
import { refundExecutor, REFUND_ACTION_TYPE, REFUND_AGENT_TYPE } from "../src/refund.js";

describe("REFUND_AGENT_TYPE", () => {
  it("is a dedicated agent type, not a reused one — so an operator can arm a type-scoped Kill on just the refund desk", () => {
    expect(REFUND_AGENT_TYPE).toBe("refund_desk");
    expect(REFUND_AGENT_TYPE).not.toBe("service");
    expect(REFUND_AGENT_TYPE).not.toBe("win_back");
  });
});

describe("refundExecutor", () => {
  it("maps action params to the RefundPort and returns an ExecutionResult", async () => {
    const adapter = new SandboxRefundAdapter();
    const exec = refundExecutor(adapter);
    const result = await exec({
      ctx: { tenantId: "t" }, agentId: "agent:svc", agentType: "service",
      action: { type: REFUND_ACTION_TYPE, params: { orderRef: "1001", usd: 25, reason: "damaged" } },
      executionId: "e1",
    });
    expect(result.ok).toBe(true);
    expect(adapter.issued[0]).toMatchObject({ orderRef: "1001", amountUsd: 25, reason: "damaged" });
  });

  it("throws (fail closed) when the required params are missing — never issues a malformed refund", async () => {
    const exec = refundExecutor(new SandboxRefundAdapter());
    await expect(
      exec({ ctx: { tenantId: "t" }, agentId: "a", agentType: "service", action: { type: REFUND_ACTION_TYPE, params: {} } }),
    ).rejects.toThrow(/orderRef|usd/);
  });
});
