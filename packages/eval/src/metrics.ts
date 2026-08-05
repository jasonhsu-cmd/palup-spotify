// Live-eval latency + token MEASUREMENT (docs/design/shopper-widget.md §8 — the 7 production suites
// include `cost ≥85` and `latency ≥88`, and until this file existed neither had any measurement at all,
// so neither could be reported, let alone gated).
//
// Scope discipline — this module MEASURES ONLY. It applies no threshold and returns no pass/fail; a later
// PR decides what the numbers have to be. Nothing here can block a candidate.
//
// Design notes (why it looks like this):
//   • It lives in packages/eval, NOT in the ports or the brain. It is a decorator around whatever
//     ModelPort the runner was already given, so no port interface and no agent code path changes and
//     the serving response passes through byte-identically (ADR-0001 stays intact).
//   • Tokens come from `ModelResponse.usage`, which ALREADY exists on the port
//     (platform-ports/src/model-port.ts) and which the Vertex adapter already populates from
//     `usageMetadata` (model-vertex/src/vertex-adapter.ts). Nothing new is invented or estimated.
//   • Percentiles and USD are NOT re-implemented here: the roll-up hands its events to
//     `rollupEvents` (whose `percentile` returns null — not NaN, not 0 — on an empty set) and its token
//     totals to `deriveCostUsd`, which derives $ from the versioned price table and reports an honest
//     `unpriced` flag for any model it has no authoritative price for (ADR-0013).
//   • One meter is created PER CASE, so the runner's concurrency pool (8 cases at a time) cannot
//     cross-attribute one case's tokens or latency to another.
import type { ModelPort, ModelRequest, ModelResponse, ModelPriceTable, TelemetryEvent } from "@palup/platform-ports";
import { deriveCostUsd, loadModelPrices, rollupEvents } from "@palup/platform-ports";

export interface TokenCount {
  input: number;
  output: number;
  total: number;
}

/** What one graded case cost, measured at the model port. */
export interface CaseMetrics {
  modelCalls: number;
  /** Sum of the measured per-call model latency for this case, ms. */
  latencyMs: number;
  tokens: TokenCount;
  /**
   * true when at least one call came back with no `usage` block (adapters may omit it). Token totals are
   * then a LOWER BOUND, flagged — never silently completed with a guess.
   */
  tokensIncomplete: boolean;
}

export interface CaseMeter {
  /** The wrapped port to hand the agent for this case. */
  port: ModelPort;
  /** The per-call events, so the run roll-up computes TRUE per-call percentiles (not per-case averages). */
  events(): TelemetryEvent[];
  metrics(): CaseMetrics;
}

/**
 * Wrap a ModelPort to count tokens and time every call for ONE case. Measurement only: the response is
 * returned unchanged, and a model failure propagates untouched and records nothing (a failed call
 * consumed no output tokens — the same choice `createMeteringModelPort` makes).
 */
export function createCaseMeter(inner: ModelPort, now: () => number = () => Date.now()): CaseMeter {
  const events: TelemetryEvent[] = [];
  let tokensIncomplete = false;
  return {
    port: {
      async complete(req: ModelRequest): Promise<ModelResponse> {
        const start = now();
        const res = await inner.complete(req);
        if (!res.usage) tokensIncomplete = true;
        events.push({
          kind: "model_call",
          model: res.model,
          inputTokens: res.usage?.inputTokens ?? 0,
          outputTokens: res.usage?.outputTokens ?? 0,
          latencyMs: now() - start,
        });
        return res;
      },
    },
    events: () => [...events],
    metrics() {
      let input = 0;
      let output = 0;
      let latencyMs = 0;
      for (const e of events) {
        input += e.inputTokens ?? 0;
        output += e.outputTokens ?? 0;
        latencyMs += e.latencyMs ?? 0;
      }
      return { modelCalls: events.length, latencyMs, tokens: { input, output, total: input + output }, tokensIncomplete };
    },
  };
}

/**
 * The measurement fields merged onto every row of reports/full-eval-report.json. `events` is the
 * per-call detail the run roll-up consumes; the writer strips it and keeps the totals.
 */
export interface CaseReportFields extends CaseMetrics {
  turns: number;
  events: TelemetryEvent[];
}

/** Snapshot one case's meter into its report row. Kept here so the report's shape is unit-testable. */
export function caseReportFields(meter: CaseMeter, turns: number): CaseReportFields {
  return { ...meter.metrics(), turns, events: meter.events() };
}

export interface RunMetrics {
  modelCalls: number;
  /** Shopper turns graded — a single turn can cost more than one model call, so this is not modelCalls. */
  turns: number;
  /** null (never NaN, never 0) when nothing was measured — matches platform-ports `percentile`. */
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  tokens: TokenCount;
  /** null when there were no turns / no calls — an undefined ratio is reported as absent, not as 0. */
  tokensPerTurn: number | null;
  tokensPerCall: number | null;
  /** Derived at read from the versioned price table. A lower bound whenever `unpriced` is true. */
  costUsd: number;
  /** true ⇒ at least one model has no authoritative price, so `costUsd` is NOT the real spend. */
  unpriced: boolean;
  unpricedModels: string[];
  /** true ⇒ some call reported no usage, so the token totals are a lower bound. */
  tokensIncomplete: boolean;
  byModel: Record<string, { calls: number; inputTokens: number; outputTokens: number; costUsd: number }>;
}

/**
 * Roll per-call events up into the run summary. `turns` is the number of shopper turns the run graded
 * (the denominator for tokens/turn). Percentiles and $ are delegated to platform-ports.
 */
export function aggregate(
  events: TelemetryEvent[],
  turns: number,
  prices: ModelPriceTable = loadModelPrices(),
  opts: { tokensIncomplete?: boolean } = {},
): RunMetrics {
  const rollup = rollupEvents("eval-run", events);
  const cost = deriveCostUsd(rollup, prices);
  const total = rollup.inputTokens + rollup.outputTokens;
  const ratio = (denom: number) => (denom > 0 ? total / denom : null);
  const byModel: RunMetrics["byModel"] = {};
  for (const [model, agg] of Object.entries(rollup.byModel)) {
    byModel[model] = {
      calls: agg.events,
      inputTokens: agg.inputTokens,
      outputTokens: agg.outputTokens,
      costUsd: cost.byModel[model]?.costUsd ?? 0,
    };
  }
  return {
    modelCalls: rollup.events,
    turns,
    latencyP50Ms: rollup.latencyP50Ms,
    latencyP95Ms: rollup.latencyP95Ms,
    tokens: { input: rollup.inputTokens, output: rollup.outputTokens, total },
    tokensPerTurn: ratio(turns),
    tokensPerCall: ratio(rollup.events),
    costUsd: cost.totalUsd,
    unpriced: !cost.fullyPriced,
    unpricedModels: cost.unpricedModels,
    tokensIncomplete: opts.tokensIncomplete ?? false,
    byModel,
  };
}

/** The human-readable run summary block. States plainly that nothing here gates. */
export function formatRunMetrics(m: RunMetrics): string {
  const ms = (v: number | null) => (v === null ? "n/a" : `${Math.round(v)}ms`);
  const n = (v: number) => v.toLocaleString("en-US");
  const per = (v: number | null) => (v === null ? "n/a" : n(Math.round(v)));
  const lines = [
    "latency + cost (MEASURED ONLY — no threshold applied, nothing here gates; see PR body):",
    `  model calls   ${n(m.modelCalls)} over ${n(m.turns)} shopper turn(s)`,
    `  latency       p50 ${ms(m.latencyP50Ms)}  p95 ${ms(m.latencyP95Ms)}  (per model call)`,
    `  tokens        ${n(m.tokens.input)} in + ${n(m.tokens.output)} out = ${n(m.tokens.total)}` +
      `  |  tokens/turn ${per(m.tokensPerTurn)}  |  tokens/call ${per(m.tokensPerCall)}`,
    `  cost          unpriced: ${m.unpriced}  usd ${m.costUsd.toFixed(6)}` +
      (m.unpriced
        ? `  ⚠️ no price entry for [${m.unpricedModels.join(", ")}] — real $ is NOT derivable; set PALUP_MODEL_PRICES`
        : ""),
  ];
  if (m.tokensIncomplete) {
    lines.push("  ⚠️ tokens     at least one model call reported no usage — token totals are a LOWER BOUND");
  }
  return lines.join("\n");
}
