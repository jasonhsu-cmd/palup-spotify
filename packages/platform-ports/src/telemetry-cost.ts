import type { TelemetryRollup } from "./telemetry-port.js";

// Cost derivation (ADR-0013): $ = tokens × price[model], computed at READ from a versioned price table,
// so a price correction re-derives history instead of rewriting immutable measurements.
//
// HONESTY: current Vertex/Gemini per-token prices are an UNVERIFIED, region/model-specific, drifting
// world fact — we do NOT hardcode a guess. The mock model is genuinely $0. Any real model is left OUT
// of the placeholder table so it surfaces as UNPRICED (flagged, cost not counted) until FinOps provides
// an authoritative table (with source + date) via PALUP_MODEL_PRICES. This keeps the $ view honest: a
// real cost never shows as a fabricated number or a misleading $0.

/** USD per 1,000,000 tokens. */
export interface ModelPrice {
  inputPer1M: number;
  outputPer1M: number;
}
export type ModelPriceTable = Record<string, ModelPrice>;

// Placeholder — the mock adapter costs nothing; real models are intentionally absent (→ flagged unpriced).
export const PLACEHOLDER_MODEL_PRICES: ModelPriceTable = {
  mock: { inputPer1M: 0, outputPer1M: 0 },
};

/** Load the price table: placeholder merged with an operator-provided PALUP_MODEL_PRICES JSON override. */
export function loadModelPrices(raw: string | undefined = process.env.PALUP_MODEL_PRICES): ModelPriceTable {
  const table: ModelPriceTable = { ...PLACEHOLDER_MODEL_PRICES };
  if (raw) {
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === "object") {
        for (const [model, p] of Object.entries(o as Record<string, unknown>)) {
          const pp = p as { inputPer1M?: unknown; outputPer1M?: unknown };
          if (typeof pp?.inputPer1M === "number" && typeof pp?.outputPer1M === "number") {
            table[model] = { inputPer1M: pp.inputPer1M, outputPer1M: pp.outputPer1M };
          }
        }
      }
    } catch {
      console.warn("[telemetry] PALUP_MODEL_PRICES is not valid JSON — using placeholder prices");
    }
  }
  return table;
}

export interface CostBreakdown {
  totalUsd: number;
  byModel: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>;
  /** Models seen in the rollup with no price entry — their cost is NOT in totalUsd (flagged, not guessed). */
  unpricedModels: string[];
  /** true only if every model in the rollup was priced; false ⇒ totalUsd is a lower bound. */
  fullyPriced: boolean;
}

export function deriveCostUsd(rollup: TelemetryRollup, prices: ModelPriceTable): CostBreakdown {
  const byModel: CostBreakdown["byModel"] = {};
  const unpricedModels: string[] = [];
  let totalUsd = 0;
  for (const [model, agg] of Object.entries(rollup.byModel)) {
    if (!Object.hasOwn(prices, model)) {
      unpricedModels.push(model);
      byModel[model] = { inputTokens: agg.inputTokens, outputTokens: agg.outputTokens, costUsd: 0 };
      continue;
    }
    const p = prices[model];
    const costUsd = (agg.inputTokens / 1_000_000) * p.inputPer1M + (agg.outputTokens / 1_000_000) * p.outputPer1M;
    byModel[model] = { inputTokens: agg.inputTokens, outputTokens: agg.outputTokens, costUsd };
    totalUsd += costUsd;
  }
  return { totalUsd, byModel, unpricedModels, fullyPriced: unpricedModels.length === 0 };
}
