import { describe, expect, it } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { DEFAULT_POLICY } from "@palup/widget-brain";
import {
  HOLDOUT_PLAY,
  assignHoldoutArm,
  holdoutIdentity,
  holdoutPeriod,
  readHoldoutConfig,
  resolveControlPolicy,
  type HoldoutConfig,
} from "../src/holdout.js";

// Wave 2 / W2-B unit coverage: the pure config/period/identity helpers and the persisted arm-assignment
// primitive `assignHoldoutArm` builds on, all exercised against `InMemoryRuntimeStore` (the same oracle
// the outcome-ledger-store tests use). Server-level (buildServer /chat) coverage is in
// holdout-serving.test.ts.

describe("readHoldoutConfig — DARK default", () => {
  it("returns { enabled:false, fraction:0 } when nothing has been written for the tenant", async () => {
    const store = new InMemoryRuntimeStore();
    expect(await readHoldoutConfig(store, "acme")).toEqual({ enabled: false, fraction: 0 });
  });

  it("returns exactly what the control plane wrote, per-tenant", async () => {
    const store = new InMemoryRuntimeStore();
    await store.put({ tenantId: "acme" }, "holdout", "config", { enabled: true, fraction: 0.2, controlPolicyId: "x" });
    expect(await readHoldoutConfig(store, "acme")).toEqual({ enabled: true, fraction: 0.2, controlPolicyId: "x" });
    // A DIFFERENT tenant's holdout is unaffected — never a global config.
    expect(await readHoldoutConfig(store, "other")).toEqual({ enabled: false, fraction: 0 });
  });
});

describe("resolveControlPolicy — v1's documented control", () => {
  it("is DEFAULT_POLICY regardless of controlPolicyId (informational only in this increment)", () => {
    const cfg: HoldoutConfig = { enabled: true, fraction: 0.5, controlPolicyId: "some-other-id" };
    expect(resolveControlPolicy(cfg)).toBe(DEFAULT_POLICY);
    expect(resolveControlPolicy({ enabled: true, fraction: 0.5 })).toBe(DEFAULT_POLICY);
  });
});

describe("holdoutPeriod — YYYY-MM in UTC", () => {
  it("formats a given date as zero-padded YYYY-MM", () => {
    expect(holdoutPeriod(new Date("2026-08-19T12:00:00Z"))).toBe("2026-08");
    expect(holdoutPeriod(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01");
    expect(holdoutPeriod(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12");
  });
});

describe("holdoutIdentity — verified shopperId preferred, else hashed sessionId", () => {
  it("prefers the verified shopperId when present", () => {
    expect(holdoutIdentity({ verifiedShopperId: "cust-42", sessionId: "sess-abc" })).toBe("shopper:cust-42");
  });

  it("falls back to a HASHED sessionId (never the raw session id) when no verified shopper", () => {
    const id = holdoutIdentity({ sessionId: "sess-abc" });
    expect(id).not.toContain("sess-abc");
    expect(id.startsWith("sess:")).toBe(true);
    // Deterministic — the same raw session id always hashes to the same identity.
    expect(id).toBe(holdoutIdentity({ sessionId: "sess-abc" }));
  });

  it("two different raw session ids hash to two different identities", () => {
    expect(holdoutIdentity({ sessionId: "sess-a" })).not.toBe(holdoutIdentity({ sessionId: "sess-b" }));
  });
});

describe("assignHoldoutArm — deterministic + persisted per (tenant, identity, period)", () => {
  it("fraction 0 ⇒ always treated; fraction 1 ⇒ always control", async () => {
    const store = new InMemoryRuntimeStore();
    expect(await assignHoldoutArm(store, "acme", { enabled: true, fraction: 0 }, "shopper:1", "2026-08")).toBe("treated");
    expect(await assignHoldoutArm(store, "acme", { enabled: true, fraction: 1 }, "shopper:2", "2026-08")).toBe("control");
  });

  it("the SAME identity+period returns the SAME arm on every call (no store write on the second call)", async () => {
    const store = new InMemoryRuntimeStore();
    const first = await assignHoldoutArm(store, "acme", { enabled: true, fraction: 0.5 }, "shopper:1", "2026-08");
    for (let i = 0; i < 5; i++) {
      expect(await assignHoldoutArm(store, "acme", { enabled: true, fraction: 0.5 }, "shopper:1", "2026-08")).toBe(first);
    }
    const audit = await store.readAudit({ tenantId: "acme" });
    expect(audit.filter((a) => a.action === "holdout_arm.assign")).toHaveLength(1); // assigned once, read back thereafter
  });

  it("PERSISTS the first assignment: a later `fraction` change cannot flip an already-assigned identity mid-period", async () => {
    const store = new InMemoryRuntimeStore();
    // fraction 1 ⇒ this identity is assigned "control" and that assignment is durably written.
    const arm = await assignHoldoutArm(store, "acme", { enabled: true, fraction: 1 }, "shopper:1", "2026-08");
    expect(arm).toBe("control");
    // The config now says fraction 0 (⇒ a FRESH identity would be "treated"), but the already-assigned
    // identity/period must still read back its ORIGINAL arm, not recompute against the new fraction.
    expect(await assignHoldoutArm(store, "acme", { enabled: true, fraction: 0 }, "shopper:1", "2026-08")).toBe("control");
  });

  it("a DIFFERENT period for the SAME identity is assigned independently", async () => {
    const store = new InMemoryRuntimeStore();
    await assignHoldoutArm(store, "acme", { enabled: true, fraction: 1 }, "shopper:1", "2026-08");
    // fraction 0 this period ⇒ this identity's NEW period gets a fresh coin flip, not the August row.
    expect(await assignHoldoutArm(store, "acme", { enabled: true, fraction: 0 }, "shopper:1", "2026-09")).toBe("treated");
  });

  it("is isolated per tenant — the same identity/period in a different tenant is assigned independently", async () => {
    const store = new InMemoryRuntimeStore();
    await assignHoldoutArm(store, "tenant-a", { enabled: true, fraction: 1 }, "shopper:1", "2026-08");
    expect(await assignHoldoutArm(store, "tenant-b", { enabled: true, fraction: 0 }, "shopper:1", "2026-08")).toBe("treated");
  });

  it("clamps an out-of-range fraction rather than trusting it blindly", async () => {
    const store = new InMemoryRuntimeStore();
    expect(await assignHoldoutArm(store, "acme", { enabled: true, fraction: 5 }, "shopper:1", "2026-08")).toBe("control");
    expect(await assignHoldoutArm(store, "acme", { enabled: true, fraction: -5 }, "shopper:2", "2026-08")).toBe("treated");
  });

  it("spreads a fraction across many identities to roughly the configured split (~20%)", async () => {
    const store = new InMemoryRuntimeStore();
    let control = 0;
    const n = 500;
    for (let i = 0; i < n; i++) {
      const arm = await assignHoldoutArm(store, "acme", { enabled: true, fraction: 0.2 }, `shopper:${i}`, "2026-08");
      if (arm === "control") control++;
    }
    // Loose bounds (a hash-based split, not a coin flip) — mirrors canary.test.ts's own loose spread check.
    expect(control / n).toBeGreaterThan(0.1);
    expect(control / n).toBeLessThan(0.3);
  });

  it("assignments are audited with the period + configured fraction, and carry a real reversal path", async () => {
    const store = new InMemoryRuntimeStore();
    await assignHoldoutArm(store, "acme", { enabled: true, fraction: 0.2 }, "shopper:1", "2026-08");
    const audit = await store.readAudit({ tenantId: "acme" });
    const rec = audit.find((a) => a.action === "holdout_arm.assign");
    expect(rec).toBeDefined();
    expect(rec?.input).toEqual({ period: "2026-08", fraction: 0.2 });
    expect(typeof rec?.reversalPath).toBe("string");
    expect(rec?.reversalPath?.length ?? 0).toBeGreaterThan(0);
  });

  it("HOLDOUT_PLAY is the documented v1 constant every turn is tallied under", () => {
    expect(HOLDOUT_PLAY).toBe("agent");
  });
});
