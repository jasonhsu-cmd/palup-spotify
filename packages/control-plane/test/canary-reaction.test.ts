import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { readOrchestratorState, rateLimitReason } from "@palup/state-postgres";
import { applyCanaryVerdict } from "../src/canary-reaction.js";

// ADR-0014 #9 — the canary verdict→freeze wiring seam, offline-testable (extracted from the
// credential-gated /api/canary/shadow endpoint).
describe("canary verdict reaction", () => {
  it("a 'rollback' verdict FREEZES the merchant's fast-lane on the correct tenant + reports rolledBack", async () => {
    const store = new InMemoryRuntimeStore();
    const r = await applyCanaryVerdict(store, "demo", "rollback", "2026-08-01T00:00:00Z");
    expect(r.rolledBack).toBe(true);
    const st = await readOrchestratorState(store, "demo");
    expect(st.frozenUntil).toBeTruthy();
    expect(rateLimitReason(st, "2026-08-02T00:00:00Z")).toMatch(/frozen/i); // +1 day: fast-lane frozen
    expect(await readOrchestratorState(store, "other-merchant")).toEqual({}); // per-merchant isolation
  });

  it("a 'hold' or 'promote' verdict does NOT freeze", async () => {
    const store = new InMemoryRuntimeStore();
    expect((await applyCanaryVerdict(store, "demo", "hold")).rolledBack).toBe(false);
    expect((await applyCanaryVerdict(store, "demo", "promote")).rolledBack).toBe(false);
    expect((await readOrchestratorState(store, "demo")).frozenUntil).toBeUndefined();
  });
});
