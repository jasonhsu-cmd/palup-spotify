import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore, type MerchantIdentityPort, type MerchantPrincipal } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";

const owner: MerchantPrincipal = { kind: "merchant_user", merchantId: "t1", userId: "shopify:t1:u1", role: "owner", authLevel: "session", sessionId: "s1" };
const idFor = (p: MerchantPrincipal | null): MerchantIdentityPort => ({
  authenticate: async (cred) => (cred === "good" && p ? p : { kind: "anonymous" }),
  authorize: () => true,
});
const mk = (p: MerchantPrincipal | null) => buildServer({ store: new InMemoryRuntimeStore(), identity: idFor(p) });

describe("auth preHandler", () => {
  it("401s an unauthenticated protected request", async () => {
    const app = await mk(owner);
    expect((await app.inject({ method: "GET", url: "/me" })).statusCode).toBe(401);
    await app.close();
  });

  it("attaches the principal when the session token is valid", async () => {
    const app = await mk(owner);
    const res = await app.inject({ method: "GET", url: "/me", headers: { authorization: "Bearer good" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ merchantId: "t1", role: "owner" });
    await app.close();
  });

  it("/health stays open with no auth", async () => {
    const app = await mk(owner);
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    await app.close();
  });
});
