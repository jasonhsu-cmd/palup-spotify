import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { readOrchestratorState, recordAutoPromotion, freezeAutoPromote, rateLimitReason } from "../src/orchestrator-registry.js";

// ADR-0014 #9 — the shared, per-merchant orchestrator state (frequency cap + freeze) on the RuntimeStatePort.
describe("orchestrator registry", () => {
  it("records a promotion + reads it back, isolated PER MERCHANT", async () => {
    const store = new InMemoryRuntimeStore();
    await recordAutoPromotion(store, "m1", "2026-08-01T00:00:00Z");
    expect((await readOrchestratorState(store, "m1")).lastPromotedAt).toBe("2026-08-01T00:00:00Z");
    expect(await readOrchestratorState(store, "m2")).toEqual({}); // merchant B unaffected by A's promotion
  });

  it("frequency cap: a promotion within the window blocks, past it clears", () => {
    const st = { lastPromotedAt: "2026-08-01T00:00:00Z" };
    expect(rateLimitReason(st, "2026-08-02T00:00:00Z")).toMatch(/frequency cap/i); // +1 day (< 7)
    expect(rateLimitReason(st, "2026-08-09T00:00:01Z")).toBeNull(); // +8 days (> 7)
  });

  it("freeze: blocks until it lifts", () => {
    const st = { frozenUntil: "2026-08-08T00:00:00Z" };
    expect(rateLimitReason(st, "2026-08-02T00:00:00Z")).toMatch(/frozen/i);
    expect(rateLimitReason(st, "2026-08-09T00:00:00Z")).toBeNull();
  });

  it("FAILS CLOSED on an unreadable clock / timestamp (never silently disables the cap)", () => {
    expect(rateLimitReason({ lastPromotedAt: "2026-08-01T00:00:00Z" }, "not-a-time")).toMatch(/unreadable/i);
    expect(rateLimitReason({ frozenUntil: "garbage" }, "2026-08-01T00:00:00Z")).toMatch(/unreadable/i);
    expect(rateLimitReason({ lastPromotedAt: "garbage" }, "2026-08-01T00:00:00Z")).toMatch(/unreadable/i);
  });

  it("freezeAutoPromote sets frozenUntil + audits, per merchant", async () => {
    const store = new InMemoryRuntimeStore();
    await freezeAutoPromote(store, "m1", "2026-08-08T00:00:00Z", "quality-regression", "2026-08-01T00:00:00Z");
    expect((await readOrchestratorState(store, "m1")).frozenUntil).toBe("2026-08-08T00:00:00Z");
    expect((await store.readAudit({ tenantId: "m1" })).map((a) => a.action)).toContain("orchestrator.freeze");
    expect(await readOrchestratorState(store, "m2")).toEqual({}); // isolation
  });
});
