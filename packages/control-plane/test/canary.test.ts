import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { verdictFor, startCanary, stopCanary, canaryConfig, DEFAULT_CANARY, MAX_CANARY_PCT } from "../src/canary-controller.js";

describe("canary config on the shared store (audited, capped, per-tenant)", () => {
  it("clamps a start pct to the 1–5% canary cap and audits it on the serving tenant's chain", async () => {
    const store = new InMemoryRuntimeStore();
    const cfg = await startCanary(store, "demo", DEFAULT_CANARY, 40);
    expect(cfg.pct).toBe(MAX_CANARY_PCT); // 40 → 5
    expect((await canaryConfig(store, "demo"))?.enabled).toBe(true);
    const audit = await store.readAudit({ tenantId: "demo" });
    expect(audit.map((a) => a.action)).toContain("canary.start");
    expect((await store.verifyAudit({ tenantId: "demo" })).ok).toBe(true);
  });

  it("stop disables the canary and audits the rollback", async () => {
    const store = new InMemoryRuntimeStore();
    await startCanary(store, "demo", DEFAULT_CANARY, 5);
    await stopCanary(store, "demo");
    expect((await canaryConfig(store, "demo"))?.enabled).toBe(false);
    expect((await store.readAudit({ tenantId: "demo" })).map((a) => a.action)).toEqual(["canary.start", "canary.stop"]);
  });

  it("a canary started for tenant A never appears for tenant B (blast-radius isolation)", async () => {
    const store = new InMemoryRuntimeStore();
    await startCanary(store, "tenant-a", DEFAULT_CANARY, 5);
    expect((await canaryConfig(store, "tenant-a"))?.enabled).toBe(true);
    expect(await canaryConfig(store, "tenant-b")).toBeNull(); // B is unaffected by A's canary
    await stopCanary(store, "tenant-a");
    expect(await canaryConfig(store, "tenant-b")).toBeNull(); // stopping A never touches B
  });
});

describe("canary shadow verdict", () => {
  it("promotes on a clear quality gain", () => expect(verdictFor(8, 0.10)).toBe("promote"));
  it("rolls back on a clear regression", () => expect(verdictFor(8, -0.10)).toBe("rollback"));
  it("holds within judge noise (±5pts)", () => {
    expect(verdictFor(8, 0.02)).toBe("hold");
    expect(verdictFor(8, -0.04)).toBe("hold");
  });
  it("reports no-traffic when there is nothing to grade", () => expect(verdictFor(0, 0)).toBe("no-traffic"));
});
