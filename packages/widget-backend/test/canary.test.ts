import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { bucket } from "../src/canary.js";
import { buildServer } from "../src/server.js";

describe("canary reads config from the shared store (multi-instance)", () => {
  it("serves the canary policy when the operator has written a config to the shared store", async () => {
    const store = new InMemoryRuntimeStore();
    // Stands in for the control plane starting a canary on the shared store (another process).
    await store.put(
      { tenantId: "__system__" },
      "canary",
      "config",
      { enabled: true, pct: 100, policy: { id: "canary-x", label: "x", styleDirective: "warm", proactivityDefault: "balanced" } },
    );
    const app = await buildServer({ store });
    const res = await app.inject({ method: "POST", url: "/chat", payload: { sessionId: "sess-x", message: "hi", signals: {} } });
    expect(res.json().servedBy).toBe("canary-x"); // pct 100 → this session is served by the canary
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
