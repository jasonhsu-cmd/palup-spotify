import { describe, it, expect } from "vitest";
import { ttlForCategory, type Proposal } from "../src/index.js";
describe("proposal model", () => {
  it("derives a category TTL in ms", () => {
    expect(ttlForCategory("discount")).toBe(24 * 3600_000);
    expect(ttlForCategory("campaign")).toBe(72 * 3600_000);
    expect(ttlForCategory("autonomy_scope")).toBe(7 * 24 * 3600_000);
  });
  it("a Proposal literal type-checks with all required fields", () => {
    const p: Proposal = { id:"p1", tenantId:"t1", agentId:"a1", agentType:"win_back",
      action:{type:"send_campaign",params:{}}, category:"campaign", rationale:"r",
      boundaryReasons:[{rule:"marketing_spend",detail:"outbound send"}],
      reversalPlan:{reversible:false,plan:"one-time send; suppress follow-up"},
      preconditions:{}, status:"pending", version:0, createdAt:"2026-08-23T00:00:00Z",
      expiresAt:"2026-08-26T00:00:00Z" };
    expect(p.status).toBe("pending");
  });
});
