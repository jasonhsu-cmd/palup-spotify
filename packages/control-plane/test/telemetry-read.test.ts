import { describe, it, expect, afterAll } from "vitest";
import { buildServer } from "../src/server.js";

// M3 slice 6: the cost/telemetry read is EXPLICITLY operator-gated even though it's a GET (the global
// hook leaves GET open for the dashboard; cost data is sensitive so this route self-authenticates).
describe("control-plane telemetry read (operator-gated GET)", () => {
  const prev = process.env.OPERATOR_TOKEN;
  afterAll(() => { if (prev === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = prev; });

  it("denies GET /api/telemetry without/with a wrong token; allows it with the operator token", async () => {
    process.env.OPERATOR_TOKEN = "test-op";
    const app = await buildServer();
    try {
      expect((await app.inject({ method: "GET", url: "/api/telemetry" })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/api/telemetry", headers: { authorization: "Bearer nope" } })).statusCode).toBe(401);
      const ok = await app.inject({ method: "GET", url: "/api/telemetry?tenantId=demo", headers: { authorization: "Bearer test-op" } });
      expect(ok.statusCode).toBe(200);
      const body = ok.json();
      expect(body.tenantId).toBe("demo");
      expect(body.rollup).toBeTruthy();
      expect(body.cost).toBeTruthy();
      expect(body.margin.status).toBe("unavailable"); // revenue ledger not built → honest, not fabricated
    } finally {
      await app.close();
    }
  });

  it("FAILS CLOSED: no OPERATOR_TOKEN configured → cost data denied", async () => {
    delete process.env.OPERATOR_TOKEN;
    const app = await buildServer();
    try {
      expect((await app.inject({ method: "GET", url: "/api/telemetry", headers: { authorization: "Bearer anything" } })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
