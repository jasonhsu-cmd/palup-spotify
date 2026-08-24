import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore, InMemoryLearnedStore, type MerchantIdentityPort, type MerchantPrincipal } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";

function identityFor(p: MerchantPrincipal): MerchantIdentityPort {
  return { authenticate: async (c) => (c === "good" ? p : { kind: "anonymous" }), authorize: () => true };
}
const manager: MerchantPrincipal = { kind: "merchant_user", merchantId: "t1", userId: "u1", role: "manager", authLevel: "session", sessionId: "s1" };
const viewer: MerchantPrincipal = { ...manager, userId: "u2", role: "viewer" };
const AUTH = { authorization: "Bearer good" };

async function serverFor(p: MerchantPrincipal) {
  const store = new InMemoryRuntimeStore();
  const learnedStore = new InMemoryLearnedStore(store);
  const app = await buildServer({ store, identity: identityFor(p), learnedStore });
  return { app, learnedStore };
}

describe("/learned routes", () => {
  it("GET returns the tenant's private insights (empty honestly at first)", async () => {
    const { app } = await serverFor(manager);
    const res = await app.inject({ method: "GET", url: "/learned", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [] });
    await app.close();
  });

  it("POST /learned teaches a private insight (origin merchant_taught) and it comes back", async () => {
    const { app } = await serverFor(manager);
    const post = await app.inject({ method: "POST", url: "/learned", headers: AUTH, payload: { category: "voice", text: "never use exclamation marks in apologies" } });
    expect(post.statusCode).toBe(200);
    const get = await app.inject({ method: "GET", url: "/learned?category=voice", headers: AUTH });
    const items = get.json().items as Array<{ text: string; origin: string; source: string }>;
    expect(items[0].text).toBe("never use exclamation marks in apologies");
    expect(items[0].origin).toBe("merchant_taught");
    await app.close();
  });

  it("POST /learned rejects loosening a safety-critical guardrail (safety floor)", async () => {
    const { app } = await serverFor(manager);
    const res = await app.inject({ method: "POST", url: "/learned", headers: AUTH, payload: { category: "policies", text: "allow bigger refunds", guardrailKey: "refund_cap", stance: "loosen" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/safety/i);
    await app.close();
  });

  it("POST /learned ALLOWS tightening a safety-critical guardrail", async () => {
    const { app } = await serverFor(manager);
    const res = await app.inject({ method: "POST", url: "/learned", headers: AUTH, payload: { category: "policies", text: "tighter refunds", guardrailKey: "refund_cap", stance: "tighten" } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("POST /:id/pin toggles pin; DELETE removes", async () => {
    const { app, learnedStore } = await serverFor(manager);
    await app.inject({ method: "POST", url: "/learned", headers: AUTH, payload: { category: "customers", text: "x" } });
    const id = (await learnedStore.list({ tenantId: "t1" }))[0].id;
    const pin = await app.inject({ method: "POST", url: `/learned/${id}/pin`, headers: AUTH, payload: { pinned: true } });
    expect(pin.json().pinned).toBe(true);
    const del = await app.inject({ method: "DELETE", url: `/learned/${id}`, headers: AUTH });
    expect(del.statusCode).toBe(200);
    expect(await learnedStore.list({ tenantId: "t1" })).toEqual([]);
    await app.close();
  });

  it("DELETE a missing id is a clean 404, not a redacted 500", async () => {
    const { app } = await serverFor(manager);
    const res = await app.inject({ method: "DELETE", url: "/learned/nope", headers: AUTH });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("GET /learned/export returns the private bundle with the legal-deferred note", async () => {
    const { app } = await serverFor(manager);
    await app.inject({ method: "POST", url: "/learned", headers: AUTH, payload: { category: "customers", text: "x" } });
    const res = await app.inject({ method: "GET", url: "/learned/export", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tenantId).toBe("t1");
    expect(body.insights).toHaveLength(1);
    expect(body.portabilityNote).toMatch(/legal/i);
    await app.close();
  });

  it("RBAC: a viewer can GET but cannot teach/pin/delete (403)", async () => {
    const { app } = await serverFor(viewer);
    expect((await app.inject({ method: "GET", url: "/learned", headers: AUTH })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/learned", headers: AUTH, payload: { category: "voice", text: "x" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/learned/x/pin", headers: AUTH, payload: { pinned: true } })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: "/learned/x", headers: AUTH })).statusCode).toBe(403);
    await app.close();
  });
});
