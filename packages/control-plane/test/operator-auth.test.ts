import { describe, it, expect, afterAll } from "vitest";
import { buildServer } from "../src/server.js";

// T4: every mutating (POST) control-plane route is default-deny — an operator must present
// `Authorization: Bearer <OPERATOR_TOKEN>`. Closes the unauthenticated kill-switch-disarm / promote hole.
describe("control-plane operator auth (default-deny on mutations)", () => {
  const prev = process.env.OPERATOR_TOKEN;
  afterAll(() => {
    if (prev === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = prev;
  });

  it("denies POST /api/kill without / with a wrong token; allows it with the right token", async () => {
    process.env.OPERATOR_TOKEN = "test-op";
    const app = await buildServer();
    try {
      expect((await app.inject({ method: "POST", url: "/api/kill" })).statusCode).toBe(401);
      expect(
        (await app.inject({ method: "POST", url: "/api/kill", headers: { authorization: "Bearer nope" } })).statusCode,
      ).toBe(401);
      const ok = await app.inject({ method: "POST", url: "/api/kill", headers: { authorization: "Bearer test-op" } });
      expect(ok.statusCode).not.toBe(401); // authenticated operator → route runs
    } finally {
      await app.close();
    }
  });

  // W1-B (deploy-prep hardening): the global onRequest hook only ever gated non-GET methods, so
  // GET /api/state (champion/candidates/history/AUDIT LOG) and GET /api/timeline were reachable by any
  // unauthenticated caller. Both now self-authenticate `operator:read`, exactly like /api/telemetry and
  // /api/canary already did — closing the last two open-GET governance-data leaks.
  it("GET /api/state and GET /api/timeline now require the operator token (no more open reads)", async () => {
    process.env.OPERATOR_TOKEN = "test-op";
    const app = await buildServer();
    try {
      expect((await app.inject({ method: "GET", url: "/api/state" })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/api/state", headers: { authorization: "Bearer nope" } })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/api/state", headers: { authorization: "Bearer test-op" } })).statusCode).toBe(200);

      expect((await app.inject({ method: "GET", url: "/api/timeline" })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/api/timeline", headers: { authorization: "Bearer test-op" } })).statusCode).toBe(200);

      // /health stays open — it carries no governance data and load balancers/uptime probes need it.
      expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  // The bind-via-HOST change in this PR makes a non-loopback deploy possible, so the two remaining open
  // GET reads — /api/runtime-kill (which agents/tenants are halted) and /api/cost-cap (budget scope) —
  // would become live governance-data leaks. Gate them like /api/state (security review MED).
  it("GET /api/runtime-kill and GET /api/cost-cap now require the operator token", async () => {
    process.env.OPERATOR_TOKEN = "test-op";
    const app = await buildServer();
    try {
      for (const url of ["/api/runtime-kill", "/api/cost-cap"]) {
        expect((await app.inject({ method: "GET", url })).statusCode, `${url} unauth`).toBe(401);
        expect((await app.inject({ method: "GET", url, headers: { authorization: "Bearer nope" } })).statusCode, `${url} wrong`).toBe(401);
        expect((await app.inject({ method: "GET", url, headers: { authorization: "Bearer test-op" } })).statusCode, `${url} ok`).toBe(200);
      }
    } finally {
      await app.close();
    }
  });

  it("FAILS CLOSED: with no OPERATOR_TOKEN configured, every mutation is denied", async () => {
    delete process.env.OPERATOR_TOKEN;
    const app = await buildServer();
    try {
      expect((await app.inject({ method: "POST", url: "/api/runtime-unkill", headers: { authorization: "Bearer anything" } })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("FAILS CLOSED: with no OPERATOR_TOKEN configured, GET /api/state and GET /api/timeline are also denied", async () => {
    delete process.env.OPERATOR_TOKEN;
    const app = await buildServer();
    try {
      expect((await app.inject({ method: "GET", url: "/api/state", headers: { authorization: "Bearer anything" } })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/api/timeline", headers: { authorization: "Bearer anything" } })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
