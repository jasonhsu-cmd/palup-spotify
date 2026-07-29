import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { verdictFor, startCanary, stopCanary, canaryConfig, DEFAULT_CANARY, MAX_CANARY_PCT } from "../src/canary-controller.js";

describe("canary config on the shared store (audited, capped)", () => {
  const SYS = { tenantId: "__system__" };
  it("clamps a start pct to the 1–5% canary cap and audits it", async () => {
    const store = new InMemoryRuntimeStore();
    const cfg = await startCanary(store, DEFAULT_CANARY, 40);
    expect(cfg.pct).toBe(MAX_CANARY_PCT); // 40 → 5
    expect((await canaryConfig(store))?.enabled).toBe(true);
    const audit = await store.readAudit(SYS);
    expect(audit.map((a) => a.action)).toContain("canary.start");
    expect((await store.verifyAudit(SYS)).ok).toBe(true);
  });
  it("stop disables the canary and audits the rollback", async () => {
    const store = new InMemoryRuntimeStore();
    await startCanary(store, DEFAULT_CANARY, 5);
    await stopCanary(store);
    expect((await canaryConfig(store))?.enabled).toBe(false);
    expect((await store.readAudit(SYS)).map((a) => a.action)).toEqual(["canary.start", "canary.stop"]);
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
