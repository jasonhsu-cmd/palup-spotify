import { describe, it, expect } from "vitest";
import { deriveCostUsd, loadModelPrices } from "../src/telemetry-cost.js";
import type { TelemetryRollup } from "../src/telemetry-port.js";

const rollup = (byModel: TelemetryRollup["byModel"]): TelemetryRollup => ({
  tenantId: "t", events: 0, inputTokens: 0, outputTokens: 0, latencyP50Ms: null, latencyP95Ms: null, byModel,
});

describe("deriveCostUsd", () => {
  it("prices known models per-1M and FLAGS unknown ones (never guesses a real cost)", () => {
    const prices = { gemini: { inputPer1M: 1.0, outputPer1M: 4.0 }, mock: { inputPer1M: 0, outputPer1M: 0 } };
    const c = deriveCostUsd(
      rollup({
        gemini: { events: 1, inputTokens: 1_000_000, outputTokens: 500_000 },
        unknownX: { events: 1, inputTokens: 1000, outputTokens: 1000 },
      }),
      prices,
    );
    expect(c.byModel.gemini.costUsd).toBeCloseTo(3.0); // 1M×$1 + 0.5M×$4
    expect(c.unpricedModels).toEqual(["unknownX"]);
    expect(c.fullyPriced).toBe(false);
    expect(c.byModel.unknownX.costUsd).toBe(0); // flagged, not guessed
    expect(c.totalUsd).toBeCloseTo(3.0); // unpriced NOT added to the total
  });

  it("mock model is genuinely $0 and fully priced", () => {
    const c = deriveCostUsd(rollup({ mock: { events: 2, inputTokens: 100, outputTokens: 100 } }), loadModelPrices(undefined));
    expect(c.totalUsd).toBe(0);
    expect(c.fullyPriced).toBe(true);
  });
});

describe("loadModelPrices", () => {
  it("merges a valid env override onto the placeholder, ignoring malformed entries", () => {
    const t = loadModelPrices(JSON.stringify({ "vertex/gemini": { inputPer1M: 2, outputPer1M: 8 }, bad: { inputPer1M: "x" } }));
    expect(t["vertex/gemini"]).toEqual({ inputPer1M: 2, outputPer1M: 8 });
    expect(t.mock).toEqual({ inputPer1M: 0, outputPer1M: 0 }); // placeholder retained
    expect(t.bad).toBeUndefined(); // malformed dropped
  });

  it("tolerates malformed / missing config (placeholder only, no throw)", () => {
    expect(loadModelPrices("not json").mock).toEqual({ inputPer1M: 0, outputPer1M: 0 });
    expect(loadModelPrices(undefined).mock).toEqual({ inputPer1M: 0, outputPer1M: 0 });
  });
});
