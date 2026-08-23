import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";

describe("merchant-backend health", () => {
  it("serves /health without auth", async () => {
    const app = await buildServer({
      store: new InMemoryRuntimeStore(),
      identity: { authenticate: async () => ({ kind: "anonymous" }), authorize: () => false },
    });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    await app.close();
  });
});
