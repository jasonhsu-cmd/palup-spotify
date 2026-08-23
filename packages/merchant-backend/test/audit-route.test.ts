import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore, type MerchantIdentityPort, type MerchantPrincipal } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";

// W1-API Task 6: GET /audit — the tenant's audit log read surface (append-only, RBAC console.view,
// tenant-scoped).

const owner: MerchantPrincipal = { kind: "merchant_user", merchantId: "t1", userId: "u1", role: "owner", authLevel: "session", sessionId: "s1" };
const viewer: MerchantPrincipal = { ...owner, role: "viewer" };

const identityFor = (p: MerchantPrincipal): MerchantIdentityPort => ({
  authenticate: async (cred) => (cred === "good" ? p : { kind: "anonymous" }),
  authorize: () => true,
});

describe("GET /audit", () => {
  it("the floor role (viewer) can read the tenant's audit entries — console.view is granted to every role", async () => {
    const state = new InMemoryRuntimeStore();
    await state.audit({ tenantId: "t1" }, { actor: "u1", action: "proposal.approved", decision: "executed" });
    await state.audit({ tenantId: "t1" }, { actor: "u1", action: "proposal.rejected", decision: "rejected" });

    const app = await buildServer({ store: state, identity: identityFor(viewer) });
    const res = await app.inject({ method: "GET", url: "/audit", headers: { authorization: "Bearer good" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(2);
    expect(body.items.map((e: { action: string }) => e.action)).toEqual(["proposal.approved", "proposal.rejected"]);
    await app.close();
  });

  it("returns entries oldest-first with seq/actor/action/hash present — the committed record shape", async () => {
    const state = new InMemoryRuntimeStore();
    await state.audit({ tenantId: "t1" }, { actor: "u1", action: "proposal.approved", decision: "executed" });

    const app = await buildServer({ store: state, identity: identityFor(owner) });
    const res = await app.inject({ method: "GET", url: "/audit", headers: { authorization: "Bearer good" } });
    const [entry] = res.json().items;
    expect(entry.seq).toBe(1);
    expect(entry.actor).toBe("u1");
    expect(entry.action).toBe("proposal.approved");
    expect(typeof entry.hash).toBe("string");
    expect(typeof entry.at).toBe("string");
    await app.close();
  });

  it("is tenant-scoped: a t2 caller never sees t1's audit rows", async () => {
    const state = new InMemoryRuntimeStore();
    await state.audit({ tenantId: "t1" }, { actor: "u1", action: "proposal.approved" });
    await state.audit({ tenantId: "t2" }, { actor: "u2", action: "proposal.rejected" });

    const ownerT2: MerchantPrincipal = { ...owner, merchantId: "t2" };
    const app = await buildServer({ store: state, identity: identityFor(ownerT2) });
    const res = await app.inject({ method: "GET", url: "/audit", headers: { authorization: "Bearer good" } });
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].action).toBe("proposal.rejected");
    await app.close();
  });

  it("returns an empty list for a tenant with no audit history yet (never an error)", async () => {
    const state = new InMemoryRuntimeStore();
    const app = await buildServer({ store: state, identity: identityFor(owner) });
    const res = await app.inject({ method: "GET", url: "/audit", headers: { authorization: "Bearer good" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
    await app.close();
  });

  it("a cursor query param is accepted (forward-compat no-op) without erroring", async () => {
    const state = new InMemoryRuntimeStore();
    await state.audit({ tenantId: "t1" }, { actor: "u1", action: "proposal.approved" });
    const app = await buildServer({ store: state, identity: identityFor(owner) });
    const res = await app.inject({ method: "GET", url: "/audit?cursor=anything", headers: { authorization: "Bearer good" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
    await app.close();
  });

  // Structural allowlist regression: `input`/`decision` are typed `unknown` and passed through
  // verbatim from ~50 write sites across the codebase. Even though every write site today redacts
  // before writing, a customer-facing read surface must not depend on all of them staying correct
  // forever — the response must be safe BY CONSTRUCTION, never a raw pass-through of the committed
  // `AuditRecord`. This proves it: seed a record whose `input`/`decision` carries a plausible
  // sensitive value and assert none of it — nor the `input`/`decision` keys themselves — ever reaches
  // the response, while the allowlisted fields (`action`, `actor`, `seq`, `at`, `hash`) still do.
  it("never leaks input/decision blobs — the response is a fixed field allowlist, not a pass-through", async () => {
    const state = new InMemoryRuntimeStore();
    await state.audit(
      { tenantId: "t1" },
      {
        actor: "u1",
        action: "proposal.approved",
        input: { secret: "sk-123", email: "a@b.com" },
        decision: { note: "internal: customer email a@b.com, key sk-123" },
        reversalPath: "n/a",
      },
    );

    const app = await buildServer({ store: state, identity: identityFor(owner) });
    const res = await app.inject({ method: "GET", url: "/audit", headers: { authorization: "Bearer good" } });
    expect(res.statusCode).toBe(200);

    const raw = JSON.stringify(res.json());
    expect(raw).not.toMatch(/sk-123/);
    expect(raw).not.toMatch(/a@b\.com/);
    expect(raw).not.toMatch(/"input"/);
    expect(raw).not.toMatch(/"decision"/);

    const [entry] = res.json().items;
    expect(entry.action).toBe("proposal.approved");
    expect(entry.actor).toBe("u1");
    expect(entry.seq).toBe(1);
    expect(typeof entry.at).toBe("string");
    expect(typeof entry.hash).toBe("string");
    expect(entry.reversalPath).toBe("n/a");
    await app.close();
  });

  it("an anonymous caller is 401'd before RBAC is even evaluated", async () => {
    const state = new InMemoryRuntimeStore();
    const app = await buildServer({ store: state, identity: { authenticate: async () => ({ kind: "anonymous" }), authorize: () => false } });
    const res = await app.inject({ method: "GET", url: "/audit" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
