import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { allowRequest } from "../src/rate-limit.js";
import { buildServer } from "../src/server.js";

describe("rate limiter — fixed window (T6)", () => {
  it("allows up to the limit, then blocks, isolates buckets, and resets after the window", async () => {
    const s = new InMemoryRuntimeStore();
    const ctx = { tenantId: "demo" };
    const t0 = 1_000_000;
    expect(await allowRequest(s, ctx, "session:a", 3, 60, t0)).toBe(true);
    expect(await allowRequest(s, ctx, "session:a", 3, 60, t0 + 1)).toBe(true);
    expect(await allowRequest(s, ctx, "session:a", 3, 60, t0 + 2)).toBe(true);
    expect(await allowRequest(s, ctx, "session:a", 3, 60, t0 + 3)).toBe(false); // over limit
    expect(await allowRequest(s, ctx, "session:b", 3, 60, t0 + 4)).toBe(true); // other bucket unaffected
    expect(await allowRequest(s, ctx, "session:a", 3, 60, t0 + 61_000)).toBe(true); // window reset
  });
});

describe("input bounds (T5)", () => {
  it("rejects an oversized message with 400", async () => {
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "s", message: "x".repeat(5_000), signals: {} }, // > MAX_MESSAGE_CHARS (4000)
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().flags).toContain("input_rejected");
    await app.close();
  });
});
