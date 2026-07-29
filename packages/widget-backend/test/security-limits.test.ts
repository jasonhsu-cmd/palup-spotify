import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { allowRequest, clientIpKey } from "../src/rate-limit.js";
import { buildServer } from "../src/server.js";

describe("clientIpKey — bound/validate the IP bucket (H1/M1)", () => {
  it("accepts a plausible IP, and sends oversized/garbage to a fallback (no huge store key)", () => {
    expect(clientIpKey("1.2.3.4, 10.0.0.1", "lb")).toBe("1.2.3.4");
    expect(clientIpKey("2001:db8::1", "lb")).toBe("2001:db8::1");
    expect(clientIpKey("x".repeat(20_000), "lb")).toBe("lb"); // oversized XFF → fallback (kills H1)
    expect(clientIpKey("not an ip!", "lb")).toBe("lb");
    expect(clientIpKey(undefined, "")).toBe("unknown");
  });
});

describe("allowRequest — per-bucket limits (T6)", () => {
  const ctx = { tenantId: "demo" };
  it("allows up to the session limit then blocks; other sessions unaffected", async () => {
    const s = new InMemoryRuntimeStore();
    const b = (sessionId: string) => ({ sessionId, ip: "1.1.1.1", sessionLimit: 2, ipLimit: 100, tenantLimit: 100, windowSeconds: 60 });
    expect(await allowRequest(s, ctx, b("a"))).toBe(true);
    expect(await allowRequest(s, ctx, b("a"))).toBe(true);
    expect(await allowRequest(s, ctx, b("a"))).toBe(false); // session limit hit
    expect(await allowRequest(s, ctx, b("z"))).toBe(true); // other session ok
  });
  it("the per-tenant ceiling caps total even across rotated sessions AND IPs (evasion backstop)", async () => {
    const s = new InMemoryRuntimeStore();
    const b = (i: number) => ({ sessionId: `s${i}`, ip: `9.9.9.${i}`, sessionLimit: 100, ipLimit: 100, tenantLimit: 3, windowSeconds: 60 });
    expect(await allowRequest(s, ctx, b(1))).toBe(true);
    expect(await allowRequest(s, ctx, b(2))).toBe(true);
    expect(await allowRequest(s, ctx, b(3))).toBe(true);
    expect(await allowRequest(s, ctx, b(4))).toBe(false); // capped despite a fresh session + IP
  });
});

describe("incrementWindow resets after the window (in-memory white-box)", () => {
  it("resets to 1 once the window elapses", async () => {
    const s = new InMemoryRuntimeStore();
    const ctx = { tenantId: "demo" };
    const t0 = 1_000_000;
    expect(await s.incrementWindow(ctx, "k", 60, t0)).toBe(1);
    expect(await s.incrementWindow(ctx, "k", 60, t0 + 1)).toBe(2);
    expect(await s.incrementWindow(ctx, "k", 60, t0 + 61_000)).toBe(1); // window elapsed → reset
  });
});

describe("input bounds (T5)", () => {
  it("rejects an oversized message with 400", async () => {
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "s", message: "x".repeat(5_000), signals: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().flags).toContain("input_rejected");
    await app.close();
  });
});
