import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { readAutoStage, recordAutoStage, autoStageComplete } from "../src/auto-stage-ledger.js";
import { recordAutoPromotion, recordAutoPromotionTx, readOrchestratorState } from "../src/orchestrator-registry.js";

// ADR-0014 T4c — a DURABLE per-tenant+candidate auto-stage ledger the terminal serveAutoChampion write
// verifies IN its tx, so even a separate process (no in-memory engine markers) is refused unless the
// ledger shows both shadow+canary complete. Makes the multi-tick canary safely resumable. Plus a
// tx-composable frequency-cap stamp so the stamp commits atomically with the champion write (T4d).

const SHADOW = { n: 8, delta: 0.1, at: "t", pass: true };
const CANARY = { n: 200, delta: 0.2, elapsedMs: 90_000_000, at: "t", pass: true };

describe("auto-stage ledger (ADR-0014 T4c: cross-process stage completion + resumable)", () => {
  it("records + round-trips a stage per (tenant, candidate)", async () => {
    const store = new InMemoryRuntimeStore();
    await recordAutoStage(store, "acme", "cand", "shadow", SHADOW, "t1");
    const led = await readAutoStage(store, "acme", "cand");
    expect(led?.shadow?.pass).toBe(true);
    expect(led?.canary).toBeUndefined();
  });

  it("autoStageComplete is false until BOTH shadow+canary are recorded as PASSING", async () => {
    const store = new InMemoryRuntimeStore();
    expect(autoStageComplete(await readAutoStage(store, "acme", "cand"))).toBe(false); // nothing recorded
    await recordAutoStage(store, "acme", "cand", "shadow", SHADOW, "t1");
    expect(autoStageComplete(await readAutoStage(store, "acme", "cand"))).toBe(false); // shadow only
    await recordAutoStage(store, "acme", "cand", "canary", CANARY, "t2");
    expect(autoStageComplete(await readAutoStage(store, "acme", "cand"))).toBe(true); // both pass
  });

  it("a FAILING shadow never counts as complete even after a passing canary", async () => {
    const store = new InMemoryRuntimeStore();
    await recordAutoStage(store, "acme", "cand", "shadow", { ...SHADOW, pass: false }, "t1");
    await recordAutoStage(store, "acme", "cand", "canary", CANARY, "t2");
    expect(autoStageComplete(await readAutoStage(store, "acme", "cand"))).toBe(false);
  });

  it("blast radius: a ledger for tenant A is invisible under tenant B, and per-candidate", async () => {
    const store = new InMemoryRuntimeStore();
    await recordAutoStage(store, "tenant-a", "cand", "shadow", SHADOW, "t1");
    expect(await readAutoStage(store, "tenant-b", "cand")).toBeNull();
    expect(await readAutoStage(store, "tenant-a", "other-cand")).toBeNull();
  });

  it("records are audited", async () => {
    const store = new InMemoryRuntimeStore();
    await recordAutoStage(store, "acme", "cand", "shadow", SHADOW, "t1");
    expect((await store.readAudit({ tenantId: "acme" })).some((a) => a.action.startsWith("auto_stage."))).toBe(true);
  });
});

describe("recordAutoPromotionTx (ADR-0014 T4c: freq-cap stamp on an existing tx handle)", () => {
  it("stamps lastPromotedAt on a passed-in tx handle (so it can commit atomically with the champion write)", async () => {
    const store = new InMemoryRuntimeStore();
    await store.tx({ tenantId: "acme" }, (t) => recordAutoPromotionTx(t, "acme", "2026-08-03T00:00:00Z"));
    expect((await readOrchestratorState(store, "acme")).lastPromotedAt).toBe("2026-08-03T00:00:00Z");
  });

  it("the standalone recordAutoPromotion still stamps (now wraps the tx variant)", async () => {
    const store = new InMemoryRuntimeStore();
    await recordAutoPromotion(store, "acme", "2026-08-04T00:00:00Z");
    expect((await readOrchestratorState(store, "acme")).lastPromotedAt).toBe("2026-08-04T00:00:00Z");
  });
});
