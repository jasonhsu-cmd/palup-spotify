import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore, InMemoryLearnedStore, type MerchantIdentityPort, type MerchantPrincipal } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";

// W3 Task 5: the insight-synthesizer's staging trigger route. Registered inside server.ts's
// authenticated `merchantPlane` context (F3), so route-protection.test.ts already proves the
// no-token path 401s; this suite covers the RBAC + agent-behavior contract this route adds, INCLUDING
// the B1 review-mandated fix: a `category:"voice"` candidate must never be recorded, even when fully
// grounded — the merchant owns voice, the agent may only propose (a separate, later path), never
// silently record/alter it.

function identityFor(p: MerchantPrincipal): MerchantIdentityPort {
  return { authenticate: async (c) => (c === "good" ? p : { kind: "anonymous" }), authorize: () => true };
}
const owner: MerchantPrincipal = { kind: "merchant_user", merchantId: "t1", userId: "u1", role: "owner", authLevel: "session", sessionId: "s1" };
const viewer: MerchantPrincipal = { ...owner, userId: "u2", role: "viewer" };
const AUTH = { authorization: "Bearer good" };

async function serverFor(p: MerchantPrincipal) {
  const store = new InMemoryRuntimeStore();
  const learnedStore = new InMemoryLearnedStore(store);
  const app = await buildServer({ store, identity: identityFor(p), learnedStore });
  return { app, learnedStore };
}

describe("POST /_internal/run-insights", () => {
  it("a grounded candidate lands one private insight (GET /learned shows it)", async () => {
    const { app } = await serverFor(owner);
    const res = await app.inject({
      method: "POST",
      url: "/_internal/run-insights",
      headers: AUTH,
      payload: { candidates: [{ category: "products", text: "Recovery set has the lowest return rate", source: "returns", sampleSize: 250 }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.recorded).toBe(1);
    expect(body.dropped).toBe(0);

    const get = await app.inject({ method: "GET", url: "/learned", headers: AUTH });
    const items = get.json().items as Array<{ text: string; origin: string; tier: string; category: string }>;
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe("Recovery set has the lowest return rate");
    expect(items[0].origin).toBe("synthesized");
    expect(items[0].tier).toBe("private");
    expect(items[0].category).toBe("products");

    await app.close();
  });

  it("a sub-floor candidate records nothing (GET stays empty)", async () => {
    const { app } = await serverFor(owner);
    const res = await app.inject({
      method: "POST",
      url: "/_internal/run-insights",
      headers: AUTH,
      payload: { candidates: [{ category: "customers", text: "thin signal", source: "orders", sampleSize: 3 }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.recorded).toBe(0);
    expect(body.dropped).toBe(1);

    const get = await app.inject({ method: "GET", url: "/learned", headers: AUTH });
    expect(get.json().items).toEqual([]);

    await app.close();
  });

  // B1: the blocker fix. A voice candidate that is fully grounded (real text, well above both the
  // sample-size floor AND the "high" confidence floor) must still end up as ZERO recorded voice
  // insights — dropped, not surfaced, no exception.
  it("NEVER records a category:voice insight, even when fully grounded", async () => {
    const { app } = await serverFor(owner);
    const res = await app.inject({
      method: "POST",
      url: "/_internal/run-insights",
      headers: AUTH,
      payload: {
        candidates: [
          { category: "voice", text: "Customers respond better to a warmer, less formal tone", source: "chat", sampleSize: 500 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.recorded).toBe(0);

    const get = await app.inject({ method: "GET", url: "/learned", headers: AUTH });
    const items = get.json().items as Array<{ category: string }>;
    expect(items).toEqual([]);
    expect(items.some((i) => i.category === "voice")).toBe(false);

    await app.close();
  });

  it("a viewer is forbidden — the route requires agent.operate", async () => {
    const { app } = await serverFor(viewer);
    const res = await app.inject({
      method: "POST",
      url: "/_internal/run-insights",
      headers: AUTH,
      payload: { candidates: [] },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("flags a special-category candidate's text in flaggedSpecial (memory-legal-gated, ADR-0015)", async () => {
    const { app } = await serverFor(owner);
    const res = await app.inject({
      method: "POST",
      url: "/_internal/run-insights",
      headers: AUTH,
      payload: {
        candidates: [
          { category: "customers", text: "customers with a nut allergy prefer the fragrance-free line", source: "chat", sampleSize: 60 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.recorded).toBe(1);
    expect(body.flaggedSpecial).toHaveLength(1);
    expect(typeof body.flaggedSpecial[0]).toBe("string");
    await app.close();
  });
});
