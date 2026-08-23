import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore, type MerchantPrincipal } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";

const principal = (role: MerchantPrincipal["role"]): MerchantPrincipal => ({
  kind: "merchant_user", merchantId: "t1", userId: "u", role, authLevel: "session", sessionId: "s",
});
const mk = (role: MerchantPrincipal["role"]) =>
  buildServer({
    store: new InMemoryRuntimeStore(),
    identity: { authenticate: async () => principal(role), authorize: () => true },
  });

describe("rbac probe", () => {
  it("viewer is forbidden from the money-gated probe", async () => {
    const app = await mk("viewer");
    expect((await app.inject({ method: "GET", url: "/_probe/money", headers: { authorization: "Bearer x" } })).statusCode).toBe(403);
    await app.close();
  });

  it("owner passes the money-gated probe", async () => {
    const app = await mk("owner");
    const res = await app.inject({ method: "GET", url: "/_probe/money", headers: { authorization: "Bearer x" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    await app.close();
  });

  it("an anonymous caller is 401'd before RBAC is even evaluated", async () => {
    const app = await buildServer({
      store: new InMemoryRuntimeStore(),
      identity: { authenticate: async () => ({ kind: "anonymous" }), authorize: () => false },
    });
    expect((await app.inject({ method: "GET", url: "/_probe/money" })).statusCode).toBe(401);
    await app.close();
  });
});
