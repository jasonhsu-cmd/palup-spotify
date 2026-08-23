import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { InMemoryProposalStore, ProposalNotFoundError, VersionConflictError } from "../src/proposal-store.js";
const ctx = { tenantId: "t1" };
const base = (id: string, over = {}) => ({ id, tenantId:"t1", agentId:"a", agentType:"win_back",
  action:{type:"x",params:{}}, category:"campaign" as const, rationale:"r",
  boundaryReasons:[], reversalPlan:{reversible:true,plan:"undo"}, preconditions:{},
  status:"pending" as const, version:0, createdAt:"2026-08-23T00:00:00Z", expiresAt:"2026-08-26T00:00:00Z", ...over });
describe("InMemoryProposalStore", () => {
  it("creates, gets, and lists by status", async () => {
    const s = new InMemoryProposalStore(new InMemoryRuntimeStore());
    await s.create(base("p1"));
    await s.create(base("p2", { status:"rejected" }));
    expect((await s.get(ctx,"p1"))?.id).toBe("p1");
    const pend = await s.list(ctx, { status:"pending" });
    expect(pend.items.map(p=>p.id)).toEqual(["p1"]);
  });
  it("enforces optimistic version on transition", async () => {
    const s = new InMemoryProposalStore(new InMemoryRuntimeStore());
    await s.create(base("p1"));
    await s.transition(ctx, "p1", 0, { status:"approved", decidedBy:"owner" });
    await expect(s.transition(ctx, "p1", 0, { status:"rejected" })).rejects.toBeInstanceOf(VersionConflictError);
  });
  it("isolates tenants", async () => {
    const s = new InMemoryProposalStore(new InMemoryRuntimeStore());
    await s.create(base("p1"));
    expect(await s.get({tenantId:"other"}, "p1")).toBeNull();
  });
  it("throws ProposalNotFoundError transitioning a missing id", async () => {
    const s = new InMemoryProposalStore(new InMemoryRuntimeStore());
    await expect(s.transition(ctx, "nope", 0, { status:"rejected" })).rejects.toBeInstanceOf(ProposalNotFoundError);
  });
});
