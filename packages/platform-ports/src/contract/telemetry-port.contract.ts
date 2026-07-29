import { describe, it, expect } from "vitest";
import type { TelemetryPort } from "../telemetry-port.js";

// Every TelemetryPort adapter must pass this (ADR-0001/0013). `make()` returns a FRESH adapter (empty).
export function runTelemetryPortContract(make: () => TelemetryPort): void {
  describe("TelemetryPort contract", () => {
    it("records events and rolls them up per tenant (tokens + latency percentiles + by-model)", async () => {
      const t = make();
      await t.record({ tenantId: "t1" }, { kind: "model_call", model: "m", inputTokens: 10, outputTokens: 5, latencyMs: 100 });
      await t.record({ tenantId: "t1" }, { kind: "model_call", model: "m", inputTokens: 20, outputTokens: 7, latencyMs: 300 });
      const r = await t.query({ tenantId: "t1" });
      expect(r.events).toBe(2);
      expect(r.inputTokens).toBe(30);
      expect(r.outputTokens).toBe(12);
      expect(r.byModel["m"]).toEqual({ events: 2, inputTokens: 30, outputTokens: 12 });
      expect(r.latencyP50Ms).not.toBeNull();
      expect(r.latencyP95Ms).not.toBeNull();
    });

    it("is tenant-isolated — one tenant's telemetry never appears in another's rollup", async () => {
      const t = make();
      await t.record({ tenantId: "a" }, { kind: "model_call", inputTokens: 99 });
      const r = await t.query({ tenantId: "b" });
      expect(r.events).toBe(0);
      expect(r.inputTokens).toBe(0);
    });

    it("record is FAIL-OPEN — never throws even on a bad tenant", async () => {
      const t = make();
      await expect(t.record({ tenantId: "" }, { kind: "turn" })).resolves.toBeUndefined();
    });

    it("empty tenant rollup has null latency percentiles (no data ≠ zero)", async () => {
      const t = make();
      const r = await t.query({ tenantId: "never-recorded" });
      expect(r.events).toBe(0);
      expect(r.latencyP50Ms).toBeNull();
      expect(r.latencyP95Ms).toBeNull();
    });
  });
}
