import { describe, expect, it } from "vitest";
import { SandboxRefundAdapter } from "../src/refund-port.js";

describe("SandboxRefundAdapter", () => {
  it("records a refund intent but NEVER issues real money, and names a real reversal path", async () => {
    const adapter = new SandboxRefundAdapter();
    const res = await adapter.issueRefund({ tenantId: "t" }, { orderRef: "1001", amountUsd: 25, reason: "goodwill" });
    expect(res.ok).toBe(true);
    expect(res.reversalPath.length).toBeGreaterThan(0);
    expect(adapter.issued).toEqual([{ tenantId: "t", orderRef: "1001", amountUsd: 25, reason: "goodwill" }]);
    expect(adapter.isLive).toBeFalsy();
  });
});
