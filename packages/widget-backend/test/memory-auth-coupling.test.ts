import { describe, it, expect, afterEach } from "vitest";
import { InMemoryRuntimeStore, createInMemoryVectorStore } from "@palup/platform-ports";
import { buildServer, assertMemoryAuthCoupling } from "../src/server.js";

// Go-live #3 — couple memory enablement to enforced widget auth. During the WIDGET_AUTH_REQUIRED
// rollout window (default off) POST /consent and the DESTRUCTIVE POST /forget are callable
// unauthenticated against RUNTIME_TENANT. Both prior security reviews recorded "set
// WIDGET_AUTH_REQUIRED=true before/at the flip" as a memory-enablement precondition. This suite proves:
//   1. the pure boot-time guard (`assertMemoryAuthCoupling`) throws exactly when memory is live and
//      widget auth is NOT enforced, and never otherwise (memory-auth-boot-guard.test.ts separately
//      proves buildServer() itself calls this guard against the REAL isMemoryEnabled() double gate);
//   2. in the configuration the guard requires (memory live + WIDGET_AUTH_REQUIRED=true), /consent and
//      /forget genuinely 401 an unauthenticated caller;
//   3. memory OFF stays byte-identical/inert: buildServer never throws, and /consent + /forget remain
//      reachable unauthenticated exactly as before this PR, regardless of WIDGET_AUTH_REQUIRED.

const VALID_ANON_ID = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // base32, passes validateAnonId's charset+length bound

const ENV_KEYS = ["WIDGET_TOKEN_SECRET", "WIDGET_AUTH_REQUIRED", "WIDGET_EMBED_KEYS"];
afterEach(() => ENV_KEYS.forEach((k) => delete process.env[k]));

describe("assertMemoryAuthCoupling — pure boot-time guard", () => {
  it("throws when memory is live but widget auth is NOT enforced", () => {
    expect(() => assertMemoryAuthCoupling(true, false)).toThrow(/WIDGET_AUTH_REQUIRED/);
  });

  it("does not throw when memory is live AND widget auth IS enforced", () => {
    expect(() => assertMemoryAuthCoupling(true, true)).not.toThrow();
  });

  it("does not throw when memory is off, regardless of widget auth", () => {
    expect(() => assertMemoryAuthCoupling(false, false)).not.toThrow();
    expect(() => assertMemoryAuthCoupling(false, true)).not.toThrow();
  });
});

describe("in the required configuration (memory live via the test seam + WIDGET_AUTH_REQUIRED=true), /consent and /forget genuinely require a verified widget token", () => {
  it("POST /consent rejects an unauthenticated caller (401), records nothing", async () => {
    process.env.WIDGET_TOKEN_SECRET = "wsecret";
    process.env.WIDGET_AUTH_REQUIRED = "true";
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const app = await buildServer({ store, vectorPort: vector, memoryEnabled: true });

    const res = await app.inject({
      method: "POST",
      url: "/consent",
      payload: { anonId: VALID_ANON_ID, memoryOrdinary: "in", memorySpecial: "out" },
    });
    expect(res.statusCode).toBe(401);
    expect((await store.readAudit({ tenantId: "demo" })).map((r) => r.action)).not.toContain("consent.record");
    await app.close();
  });

  it("POST /forget rejects an unauthenticated caller (401), erases nothing", async () => {
    process.env.WIDGET_TOKEN_SECRET = "wsecret";
    process.env.WIDGET_AUTH_REQUIRED = "true";
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const app = await buildServer({ store, vectorPort: vector, memoryEnabled: true });

    const res = await app.inject({ method: "POST", url: "/forget", payload: { anonId: VALID_ANON_ID } });
    expect(res.statusCode).toBe(401);
    expect((await store.readAudit({ tenantId: "demo" })).map((r) => r.action)).not.toContain("erase.subject");
    await app.close();
  });

  it("a verified widget token (merchant principal) DOES pass both endpoints", async () => {
    process.env.WIDGET_TOKEN_SECRET = "wsecret";
    process.env.WIDGET_AUTH_REQUIRED = "true";
    process.env.WIDGET_EMBED_KEYS = JSON.stringify({ "acme-key": "acme" });
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const app = await buildServer({ store, vectorPort: vector, memoryEnabled: true });

    const token = (await app.inject({ method: "GET", url: "/widget/token?key=acme-key" })).json().token as string;
    const consentRes = await app.inject({
      method: "POST",
      url: "/consent",
      headers: { authorization: "Bearer " + token },
      payload: { anonId: VALID_ANON_ID, memoryOrdinary: "in", memorySpecial: "out" },
    });
    expect(consentRes.statusCode).toBe(200);

    const forgetRes = await app.inject({
      method: "POST",
      url: "/forget",
      headers: { authorization: "Bearer " + token },
      payload: { anonId: VALID_ANON_ID },
    });
    expect(forgetRes.statusCode).toBe(200);
    await app.close();
  });
});

describe("memory OFF (real production posture) — byte-identical to before this PR", () => {
  it("buildServer boots without throwing whether or not WIDGET_AUTH_REQUIRED is set", async () => {
    const appOff = await buildServer({ store: new InMemoryRuntimeStore() });
    await appOff.close();

    process.env.WIDGET_AUTH_REQUIRED = "true";
    const appOn = await buildServer({ store: new InMemoryRuntimeStore() });
    await appOn.close();
  });

  it("/consent and /forget remain reachable unauthenticated when WIDGET_AUTH_REQUIRED is unset (inert rollout posture unchanged)", async () => {
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });

    const consentRes = await app.inject({
      method: "POST",
      url: "/consent",
      payload: { anonId: VALID_ANON_ID, memoryOrdinary: "in", memorySpecial: "out" },
    });
    expect(consentRes.statusCode).toBe(200);

    const forgetRes = await app.inject({ method: "POST", url: "/forget", payload: { anonId: VALID_ANON_ID } });
    expect(forgetRes.statusCode).toBe(200);
    await app.close();
  });
});
