import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore, type MerchantIdentityPort, type MerchantPrincipal } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";

// W2 Task 5: GET /activity — the merchant-facing agent-activity feed, an ALLOWLIST read model over
// the audit log (D8). Proves: allowlist filtering (metric/config plumbing excluded), newest-first
// order, the fixed safe DTO (no input/decision blobs), tenant scoping, and RBAC.

const viewer: MerchantPrincipal = { kind: "merchant_user", merchantId: "t1", userId: "u1", role: "viewer", authLevel: "session", sessionId: "s1" };

const identityFor = (p: MerchantPrincipal): MerchantIdentityPort => ({
  authenticate: async (cred) => (cred === "good" ? p : { kind: "anonymous" }),
  authorize: () => true,
});

const ctx = { tenantId: "t1" };

describe("GET /activity", () => {
  it("returns ONLY agent-activity actions, newest first, as the fixed safe DTO", async () => {
    const state = new InMemoryRuntimeStore();
    await state.audit(ctx, { actor: "win_back_agent", action: "proposal.created", input: { SECRET: "never-shown" }, decision: { alsoSecret: true } }, "2026-08-24T01:00:00.000Z");
    await state.audit(ctx, { actor: "outcome-ledger", action: "arm_tally.accumulate" }, "2026-08-24T02:00:00.000Z"); // plumbing — excluded
    await state.audit(ctx, { actor: "u1", action: "rules.changed" }, "2026-08-24T03:00:00.000Z"); // config — excluded (it has its own screen)
    await state.audit(ctx, { actor: "u1", action: "proposal.approved" }, "2026-08-24T04:00:00.000Z");

    const app = await buildServer({ store: state, identity: identityFor(viewer) });
    const res = await app.inject({ method: "GET", url: "/activity", headers: { authorization: "Bearer good" } });
    expect(res.statusCode).toBe(200);
    const { items } = res.json();
    expect(items).toEqual([
      { seq: 4, at: "2026-08-24T04:00:00.000Z", actor: "u1", action: "proposal.approved" },
      { seq: 1, at: "2026-08-24T01:00:00.000Z", actor: "win_back_agent", action: "proposal.created" },
    ]);
    // The safe-DTO allowlist holds structurally: no entry carries the raw blobs.
    expect(JSON.stringify(items)).not.toContain("SECRET");
    await app.close();
  });

  it("accepts ?cursor= as a forward-compat no-op (the audit-route convention)", async () => {
    const state = new InMemoryRuntimeStore();
    const app = await buildServer({ store: state, identity: identityFor(viewer) });
    const res = await app.inject({ method: "GET", url: "/activity?cursor=abc", headers: { authorization: "Bearer good" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [] }); // honest empty — never a fabricated feed
    await app.close();
  });

  it("tenant scoping: another tenant's activity never appears", async () => {
    const state = new InMemoryRuntimeStore();
    await state.audit({ tenantId: "t2" }, { actor: "win_back_agent", action: "proposal.created" });
    const app = await buildServer({ store: state, identity: identityFor(viewer) });
    const res = await app.inject({ method: "GET", url: "/activity", headers: { authorization: "Bearer good" } });
    expect(res.json().items).toEqual([]);
    await app.close();
  });

  it("an anonymous caller is 401'd", async () => {
    const app = await buildServer({ store: new InMemoryRuntimeStore(), identity: identityFor(viewer) });
    const res = await app.inject({ method: "GET", url: "/activity" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
