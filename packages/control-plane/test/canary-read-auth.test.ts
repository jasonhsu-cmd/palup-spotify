import { describe, it, expect, afterAll } from "vitest";
import { buildServer } from "../src/server.js";

// Security review B1 (T0): GET /api/canary returns a caller-named tenant's canary stats + config. The
// global operator hook leaves GET open (dashboard reads), so — exactly like /api/telemetry — this route
// must self-authenticate `operator:read`, or an anonymous caller reads ANY merchant's canary data via
// ?tenantId=<victim>. T0 is the change that turned a fixed-"demo" read into an arbitrary-tenant one, so
// T0 must also close the door.
describe("control-plane canary read (operator-gated GET) — ADR-0014 #4 / SECURITY §2 cross-tenant", () => {
  const prev = process.env.OPERATOR_TOKEN;
  afterAll(() => { if (prev === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = prev; });

  it("denies GET /api/canary without/with a wrong token; allows it with the operator token", async () => {
    process.env.OPERATOR_TOKEN = "test-op";
    const app = await buildServer();
    try {
      expect((await app.inject({ method: "GET", url: "/api/canary?tenantId=demo" })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/api/canary?tenantId=demo", headers: { authorization: "Bearer nope" } })).statusCode).toBe(401);
      const ok = await app.inject({ method: "GET", url: "/api/canary?tenantId=demo", headers: { authorization: "Bearer test-op" } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().config !== undefined).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("FAILS CLOSED: no OPERATOR_TOKEN configured → canary data denied", async () => {
    delete process.env.OPERATOR_TOKEN;
    const app = await buildServer();
    try {
      expect((await app.inject({ method: "GET", url: "/api/canary?tenantId=demo", headers: { authorization: "Bearer anything" } })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
