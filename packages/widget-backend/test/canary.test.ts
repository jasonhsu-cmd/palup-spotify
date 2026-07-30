import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { bucket } from "../src/canary.js";
import { buildServer } from "../src/server.js";

const CANARY_POLICY = { id: "canary-x", label: "x", styleDirective: "warm", proactivityDefault: "balanced" };

// The unauthenticated /chat path serves the "demo" tenant (WIDGET_AUTH_REQUIRED off), so a canary is
// applied to this session only if it is written under the SERVING tenant's config — never a global
// __system__ key and never another merchant's config (ADR-0014 blast-radius isolation).
describe("canary is per-tenant on the shared store (multi-instance, blast-radius isolated)", () => {
  it("serves THIS tenant's canary when the control plane wrote that tenant's config", async () => {
    const store = new InMemoryRuntimeStore();
    // Stands in for the control plane starting a canary for the demo merchant (another process).
    await store.put({ tenantId: "demo" }, "canary", "config", { enabled: true, pct: 100, policy: CANARY_POLICY });
    const app = await buildServer({ store });
    const res = await app.inject({ method: "POST", url: "/chat", payload: { sessionId: "sess-x", message: "hi", signals: {} } });
    expect(res.json().servedBy).toBe("canary-x"); // pct 100 → this session is served by the demo tenant's canary
    await app.close();
  });

  it("does NOT serve a canary started for a DIFFERENT tenant (blast-radius isolation)", async () => {
    const store = new InMemoryRuntimeStore();
    // A canary exists ONLY for another merchant — it must never bucket the demo tenant's shoppers.
    await store.put({ tenantId: "other-merchant" }, "canary", "config", { enabled: true, pct: 100, policy: CANARY_POLICY });
    const app = await buildServer({ store });
    const res = await app.inject({ method: "POST", url: "/chat", payload: { sessionId: "sess-x", message: "hi", signals: {} } });
    expect(res.json().servedBy).not.toBe("canary-x"); // demo serves its own champion, unaffected by another tenant's canary
    await app.close();
  });
});

describe("canary session bucket (sticky split)", () => {
  it("is deterministic per session and in [0,100)", () => {
    const b = bucket("session-abc");
    expect(b).toBe(bucket("session-abc")); // sticky — same session, same side
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(100);
  });
  it("spreads distinct sessions across buckets", () => {
    const buckets = new Set(Array.from({ length: 60 }, (_, i) => bucket(`s-${i}`)));
    expect(buckets.size).toBeGreaterThan(15); // not all colliding
  });
});
