import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryRuntimeStore, InMemoryProposalStore, type MerchantIdentityPort, type MerchantPrincipal, type Proposal } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";

// Task 2 (W1-API): GET /approvals (list, tenant-scoped, status/category filter) + GET
// /approvals/:id (detail, 404 on cross-tenant — never a 403 that would leak the row exists on
// another tenant). RBAC note (verified `packages/platform-ports/src/merchant-identity-port.ts`):
// `console.view` is in EVERY role's default grant (`VIEWER` already has it, and grants are
// additive up the ladder) — so there is no real `MerchantRole` that gets 403 from these routes.
// The meaningful authorization assertions here are therefore: (a) the floor role (`viewer`)
// succeeds, and (b) an unauthenticated caller is 401'd (RBAC never reached) — the actual `403`
// carve-out the task-2 brief flagged as conditional ("if any role lacks it") does not apply.

const owner: MerchantPrincipal = { kind: "merchant_user", merchantId: "t1", userId: "u1", role: "owner", authLevel: "session", sessionId: "s1" };
const viewer: MerchantPrincipal = { ...owner, role: "viewer" };
const ownerT2: MerchantPrincipal = { ...owner, merchantId: "t2" };

const identityFor = (p: MerchantPrincipal): MerchantIdentityPort => ({
  authenticate: async (cred) => (cred === "good" ? p : { kind: "anonymous" }),
  authorize: () => true,
});

function makeProposal(overrides: Partial<Proposal> & { id: string; tenantId: string }): Proposal {
  return {
    agentId: "win_back_agent",
    agentType: "win_back",
    action: { type: "send_campaign", params: {} },
    category: "campaign",
    rationale: "r",
    boundaryReasons: [],
    reversalPlan: { reversible: false, plan: "contain + correct" },
    preconditions: {},
    status: "pending",
    version: 0,
    createdAt: "2026-08-01T00:00:00Z",
    expiresAt: "2026-08-04T00:00:00Z",
    ...overrides,
  };
}

describe("GET /approvals + GET /approvals/:id", () => {
  let state: InMemoryRuntimeStore;
  let proposalStore: InMemoryProposalStore;

  beforeEach(async () => {
    state = new InMemoryRuntimeStore();
    proposalStore = new InMemoryProposalStore(state);
    // 2 pending + 1 rejected for t1, 1 (pending) for t2.
    await proposalStore.create(makeProposal({ id: "p1", tenantId: "t1", status: "pending" }));
    await proposalStore.create(makeProposal({ id: "p2", tenantId: "t1", status: "pending" }));
    await proposalStore.create(makeProposal({ id: "p3", tenantId: "t1", status: "rejected", decidedBy: "u1", decidedAt: "2026-08-02T00:00:00Z", decisionNote: "no" }));
    await proposalStore.create(makeProposal({ id: "p4", tenantId: "t2", status: "pending" }));
  });

  it("lists only the caller's tenant's pending proposals when filtered by status=pending", async () => {
    const app = await buildServer({ store: state, identity: identityFor(owner), proposalStore });
    const res = await app.inject({ method: "GET", url: "/approvals?status=pending", headers: { authorization: "Bearer good" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(2);
    expect(body.items.map((p: Proposal) => p.id).sort()).toEqual(["p1", "p2"]);
    for (const item of body.items) expect(item.tenantId).toBe("t1");
    await app.close();
  });

  it("filters by category", async () => {
    const app = await buildServer({ store: state, identity: identityFor(owner), proposalStore });
    const res = await app.inject({ method: "GET", url: "/approvals?category=campaign", headers: { authorization: "Bearer good" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(3); // p1, p2, p3 — all t1, all category=campaign
    await app.close();
  });

  it("the floor role (viewer) can list — console.view is granted to every role", async () => {
    const app = await buildServer({ store: state, identity: identityFor(viewer), proposalStore });
    const res = await app.inject({ method: "GET", url: "/approvals", headers: { authorization: "Bearer good" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(3); // all t1 proposals, unfiltered
    await app.close();
  });

  it("an anonymous caller is 401'd before RBAC is even evaluated", async () => {
    const app = await buildServer({ store: state, identity: { authenticate: async () => ({ kind: "anonymous" }), authorize: () => false }, proposalStore });
    const res = await app.inject({ method: "GET", url: "/approvals" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("GET /approvals/:id returns the caller's own-tenant proposal", async () => {
    const app = await buildServer({ store: state, identity: identityFor(owner), proposalStore });
    const res = await app.inject({ method: "GET", url: "/approvals/p1", headers: { authorization: "Bearer good" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe("p1");
    expect(res.json().tenantId).toBe("t1");
    await app.close();
  });

  it("GET /approvals/:id 404s for a cross-tenant proposal — never leaks it exists", async () => {
    const app = await buildServer({ store: state, identity: identityFor(owner), proposalStore }); // owner is t1
    const res = await app.inject({ method: "GET", url: "/approvals/p4", headers: { authorization: "Bearer good" } }); // p4 is t2
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("GET /approvals/:id 404s for an id that doesn't exist at all", async () => {
    const app = await buildServer({ store: state, identity: identityFor(owner), proposalStore });
    const res = await app.inject({ method: "GET", url: "/approvals/does-not-exist", headers: { authorization: "Bearer good" } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("a t2 viewer sees only their own tenant's proposal via list, confirming tenant-scoping both ways", async () => {
    const app = await buildServer({ store: state, identity: identityFor(ownerT2), proposalStore });
    const res = await app.inject({ method: "GET", url: "/approvals", headers: { authorization: "Bearer good" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe("p4");
    await app.close();
  });
});
