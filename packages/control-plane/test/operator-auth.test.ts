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

  it("denies POST /api/kill without / with a wrong token; allows it with the right token; reads stay open", async () => {
    process.env.OPERATOR_TOKEN = "test-op";
    const app = await buildServer();
    try {
      expect((await app.inject({ method: "POST", url: "/api/kill" })).statusCode).toBe(401);
      expect(
        (await app.inject({ method: "POST", url: "/api/kill", headers: { authorization: "Bearer nope" } })).statusCode,
      ).toBe(401);
      const ok = await app.inject({ method: "POST", url: "/api/kill", headers: { authorization: "Bearer test-op" } });
      expect(ok.statusCode).not.toBe(401); // authenticated operator → route runs
      expect((await app.inject({ method: "GET", url: "/api/state" })).statusCode).toBe(200); // reads open
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
});
