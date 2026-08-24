import { describe, expect, it } from "vitest";
import { SandboxRefundAdapter } from "@palup/platform-ports";
import { REFUND_ACTION_TYPE } from "@palup/agent-runtime";
import { resolveExecutor, resolveValidator } from "../src/engine-wiring.js";

// W5 Task 8: unit-level registry coverage for wiring `issue_refund` into `resolveExecutor` /
// `resolveValidator`, mirroring the `change_rules` (W4-broaden Task 7) coverage in
// `engine-wiring.test.ts`. The real end-to-end proof (approved refund via the ACTUAL
// `POST /approvals/:id/approve` route, reversal-path-in-audit, kill-switch 423, idempotent
// re-approve, and non-disturbance of the other executors) lives in `approve.test.ts`'s
// "agent-proposed refund" describe block — this file only proves the registry seam itself.

describe("engine-wiring refund", () => {
  it("resolves issue_refund to a refund executor bound to the RefundPort", async () => {
    const adapter = new SandboxRefundAdapter();
    const exec = resolveExecutor(REFUND_ACTION_TYPE, { comms: {} as never, refundPort: adapter });
    await exec({ ctx: { tenantId: "t" }, agentId: "a", agentType: "service", action: { type: REFUND_ACTION_TYPE, params: { orderRef: "1001", usd: 25 } } });
    expect(adapter.issued).toHaveLength(1);
  });

  it("throws (fail closed) when a refund is approved with no RefundPort wired", () => {
    expect(() => resolveExecutor(REFUND_ACTION_TYPE, { comms: {} as never })).toThrow(/refundPort/);
  });

  it("resolves the refund category to a validator (does not throw)", async () => {
    const validate = resolveValidator("refund", { comms: {} as never });
    expect(await validate({} as never, { tenantId: "t" })).toEqual({ valid: true });
  });
});
