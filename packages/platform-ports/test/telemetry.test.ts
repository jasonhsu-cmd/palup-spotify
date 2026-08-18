import { describe, it, expect } from "vitest";
import { runTelemetryPortContract } from "@palup/platform-ports/contract/telemetry";
import { createStoreTelemetry, rollupEvents } from "../src/telemetry-port.js";
import { InMemoryRuntimeStore } from "../src/in-memory-runtime-store.js";

// The store-backed adapter satisfies the TelemetryPort contract.
runTelemetryPortContract(() => createStoreTelemetry(new InMemoryRuntimeStore()));

describe("rollupEvents", () => {
  it("computes p50/p95 over the latency samples and sums tokens by model", () => {
    const r = rollupEvents("t", [
      { kind: "model_call", model: "gemini", inputTokens: 100, outputTokens: 50, latencyMs: 100 },
      { kind: "model_call", model: "gemini", inputTokens: 200, outputTokens: 60, latencyMs: 200 },
      { kind: "model_call", model: "mock", inputTokens: 5, outputTokens: 5, latencyMs: 1000 },
      { kind: "turn", mode: "sales", latencyMs: 300 }, // a turn event carries latency but no tokens/model
    ]);
    expect(r.events).toBe(4);
    expect(r.inputTokens).toBe(305);
    expect(r.outputTokens).toBe(115);
    expect(r.byModel.gemini).toEqual({ events: 2, inputTokens: 300, outputTokens: 110 });
    expect(r.byModel.mock.events).toBe(1);
    expect(r.byModel.turn).toBeUndefined(); // "turn" events have no model → not a model bucket
    expect(r.latencyP50Ms).not.toBeNull();
    expect(r.latencyP95Ms).toBe(1000); // top of the sorted sample
  });

  it("returns null percentiles and zero tokens for an empty set", () => {
    const r = rollupEvents("t", []);
    expect(r).toMatchObject({ events: 0, inputTokens: 0, outputTokens: 0, latencyP50Ms: null, latencyP95Ms: null, byModel: {} });
  });

  it("aggregates by ModelTier (byTier) exactly like byModel, for events that carry one", () => {
    const r = rollupEvents("t", [
      { kind: "model_call", model: "gemini-flash", tier: "routine", inputTokens: 100, outputTokens: 20 },
      { kind: "model_call", model: "gemini-flash", tier: "routine", inputTokens: 200, outputTokens: 30 },
      { kind: "model_call", model: "gemini-pro", tier: "high_stakes", inputTokens: 50, outputTokens: 10 },
      { kind: "model_call", model: "mock" }, // no tier — not counted in byTier
    ]);
    expect(r.byTier?.routine).toEqual({ events: 2, inputTokens: 300, outputTokens: 50 });
    expect(r.byTier?.high_stakes).toEqual({ events: 1, inputTokens: 50, outputTokens: 10 });
    expect(r.byTier?.canary).toBeUndefined(); // never seen → never fabricated
  });

  it("byTier is present but empty when no event in the window carries a tier (same convention as byModel)", () => {
    const r = rollupEvents("t", [{ kind: "model_call", model: "mock", inputTokens: 1 }]);
    expect(r.byTier).toEqual({});
  });
});

describe("TelemetryEvent optional category/tier fields", () => {
  it("record()/query() round-trip category and tier through the store-backed adapter unchanged", async () => {
    const { InMemoryRuntimeStore } = await import("../src/in-memory-runtime-store.js");
    const telemetry = createStoreTelemetry(new InMemoryRuntimeStore());
    await telemetry.record({ tenantId: "t1" }, { kind: "model_call", model: "gemini-flash", category: "inference", tier: "routine", inputTokens: 10, outputTokens: 5 });
    const r = await telemetry.query({ tenantId: "t1" });
    expect(r.byTier?.routine).toEqual({ events: 1, inputTokens: 10, outputTokens: 5 });
  });

  it("an event with neither category nor tier still rolls up exactly as before (fully backward compatible)", () => {
    const r = rollupEvents("t", [{ kind: "model_call", model: "mock", inputTokens: 1, outputTokens: 1 }]);
    expect(r.byModel.mock).toEqual({ events: 1, inputTokens: 1, outputTokens: 1 });
    expect(r.byTier).toEqual({});
  });
});
