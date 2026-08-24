import { describe, it, expect } from "vitest";
import {
  InMemoryLearnedStore, InMemoryRuntimeStore, gradeInsight, isSafetyFloorViolation,
  INSIGHT_SURFACE_MIN_SAMPLE, INSIGHT_HIGH_CONFIDENCE_MIN_SAMPLE,
  LearnedInsightNotFoundError, type LearnedInsight,
} from "../src/index.js";
import { learnedStoreContract } from "../src/contract/learned-store.contract.js";

function insight(over: Partial<LearnedInsight> = {}): LearnedInsight {
  return {
    id: "l1", tenantId: "t1", category: "customers", tier: "private", origin: "synthesized",
    text: "First-time buyers convert more with a sample add-on",
    grounding: { source: "orders", sampleSize: 250, confidence: "high" },
    pinned: false, createdAt: "2026-08-24T00:00:00Z", updatedAt: "2026-08-24T00:00:00Z", ...over,
  };
}

describe("gradeInsight (conservative grounding)", () => {
  it("drops an insight below the surface sample floor", () => {
    expect(gradeInsight({ category: "customers", text: "x", source: "orders", sampleSize: INSIGHT_SURFACE_MIN_SAMPLE - 1 }))
      .toEqual({ surface: false, reason: expect.stringContaining("below floor") });
  });
  it("surfaces at medium below the high floor and high at/above it", () => {
    expect(gradeInsight({ category: "customers", text: "x", source: "orders", sampleSize: 50 })).toEqual({ surface: true, confidence: "medium" });
    expect(gradeInsight({ category: "customers", text: "x", source: "orders", sampleSize: INSIGHT_HIGH_CONFIDENCE_MIN_SAMPLE })).toEqual({ surface: true, confidence: "high" });
  });
  it("drops an insight with no grounding source or empty text", () => {
    expect(gradeInsight({ category: "customers", text: "x", source: "  ", sampleSize: 999 }).surface).toBe(false);
    expect(gradeInsight({ category: "customers", text: "  ", source: "orders", sampleSize: 999 }).surface).toBe(false);
  });
});

describe("isSafetyFloorViolation (teaching safety floor)", () => {
  it("rejects loosening a safety-critical guardrail, allows tightening it", () => {
    expect(isSafetyFloorViolation("refund_cap", "loosen")).toBe(true);
    expect(isSafetyFloorViolation("refund_cap", "tighten")).toBe(false);
  });
  it("allows both directions for a non-safety guardrail key", () => {
    expect(isSafetyFloorViolation("email_signoff", "loosen")).toBe(false);
    expect(isSafetyFloorViolation("email_signoff", "tighten")).toBe(false);
  });
});

describe("InMemoryLearnedStore", () => {
  const ctx = { tenantId: "t1" };
  it("records, lists newest-first, filters by category, and audits", async () => {
    const rt = new InMemoryRuntimeStore();
    const s = new InMemoryLearnedStore(rt);
    await s.record(ctx, insight({ id: "a", category: "customers", createdAt: "2026-08-24T00:00:00Z" }), "owner");
    await s.record(ctx, insight({ id: "b", category: "voice", createdAt: "2026-08-24T01:00:00Z" }), "owner");
    const all = await s.list(ctx);
    expect(all.map((i) => i.id)).toEqual(["b", "a"]);
    expect((await s.list(ctx, { category: "voice" })).map((i) => i.id)).toEqual(["b"]);
    const audit = await rt.readAudit(ctx);
    expect(audit.some((r) => r.action === "learned.recorded")).toBe(true);
  });
  it("the aggregate tier is never served from the private store (hard wall)", async () => {
    const s = new InMemoryLearnedStore(new InMemoryRuntimeStore());
    await s.record(ctx, insight({ id: "a" }), "owner");
    expect(await s.list(ctx, { tier: "aggregate" })).toEqual([]);
  });
  it("isolates tenants", async () => {
    const s = new InMemoryLearnedStore(new InMemoryRuntimeStore());
    await s.record(ctx, insight({ id: "a" }), "owner");
    expect(await s.list({ tenantId: "other" })).toEqual([]);
  });
  it("toggles pin and removes, throwing on a missing id", async () => {
    const s = new InMemoryLearnedStore(new InMemoryRuntimeStore());
    await s.record(ctx, insight({ id: "a", pinned: false }), "owner");
    expect((await s.setPinned(ctx, "a", true, "owner", "2026-08-24T02:00:00Z")).pinned).toBe(true);
    await s.remove(ctx, "a", "owner", "2026-08-24T03:00:00Z");
    expect(await s.get(ctx, "a")).toBeNull();
    await expect(s.setPinned(ctx, "missing", true, "owner", "t")).rejects.toBeInstanceOf(LearnedInsightNotFoundError);
    await expect(s.remove(ctx, "missing", "owner", "t")).rejects.toBeInstanceOf(LearnedInsightNotFoundError);
  });
});

// Prove the shared contract passes against the in-memory adapter (Postgres reuses it in Task 3).
learnedStoreContract(() => new InMemoryLearnedStore(new InMemoryRuntimeStore()));
