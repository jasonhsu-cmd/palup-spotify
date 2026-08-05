import { describe, it, expect } from "vitest";
import type { ModelPort, ModelResponse } from "@palup/platform-ports";
import { PLACEHOLDER_MODEL_PRICES } from "@palup/platform-ports";
import {
  createCaseMeter,
  caseReportFields,
  aggregate,
  formatRunMetrics,
  type CaseMeter,
} from "../src/metrics.js";
import * as metrics from "../src/metrics.js";

// The whole point of this file: the live-eval latency/token measurement is provable with NO cloud creds
// and NO network. The model is a FAKE ModelPort injected into the decorator — the same discipline as
// packages/model-vertex/test/vertex-adapter.test.ts, which injects a fake `GenerateFn` so every bit of
// the adapter's own logic is unit-tested without Vertex.
function fakeModel(opts: { model?: string; usage?: boolean } = {}): ModelPort {
  let n = 0;
  return {
    async complete(): Promise<ModelResponse> {
      n++;
      return {
        text: `fake reply ${n}`,
        model: opts.model ?? "gemini-test",
        usage: opts.usage === false ? undefined : { inputTokens: 100, outputTokens: 20 },
      };
    },
  };
}

// A clock that advances 50ms on every read, exactly like platform-ports/test/metering.test.ts — so one
// wrapped call (read at start, read at end) measures a deterministic 50ms.
function fakeClock(step = 50) {
  let t = 1_000;
  return () => (t += step);
}

describe("createCaseMeter — per-case counting/timing decorator around the ModelPort", () => {
  it("passes the response through byte-identically (it measures, it never alters serving)", async () => {
    const meter = createCaseMeter(fakeModel(), fakeClock());
    const res = await meter.port.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(res.text).toBe("fake reply 1");
    expect(res.model).toBe("gemini-test");
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
  });

  it("counts calls, sums the ALREADY-EXISTING ModelResponse.usage tokens, and times each call", async () => {
    const meter = createCaseMeter(fakeModel(), fakeClock());
    await meter.port.complete({ messages: [{ role: "user", content: "a" }] });
    await meter.port.complete({ messages: [{ role: "user", content: "b" }] });
    const m = meter.metrics();
    expect(m.modelCalls).toBe(2);
    expect(m.tokens).toEqual({ input: 200, output: 40, total: 240 });
    expect(m.latencyMs).toBe(100); // 50ms per call, summed
    expect(m.tokensIncomplete).toBe(false);
  });

  it("flags tokensIncomplete when an adapter returns no usage — tokens are a LOWER BOUND, never a guess", async () => {
    const meter = createCaseMeter(fakeModel({ usage: false }), fakeClock());
    await meter.port.complete({ messages: [{ role: "user", content: "a" }] });
    const m = meter.metrics();
    expect(m.modelCalls).toBe(1);
    expect(m.tokens.total).toBe(0);
    expect(m.tokensIncomplete).toBe(true);
    expect(m.latencyMs).toBe(50); // latency is still measured — it does not depend on usage
  });

  it("re-throws a model failure and records nothing for it (mirrors createMeteringModelPort)", async () => {
    const boom: ModelPort = { async complete() { throw new Error("model exploded"); } };
    const meter = createCaseMeter(boom, fakeClock());
    await expect(meter.port.complete({ messages: [] })).rejects.toThrow("model exploded");
    expect(meter.events()).toEqual([]);
    expect(meter.metrics().modelCalls).toBe(0);
  });

  it("emits one telemetry-shaped model_call event per call, so the run aggregate sees TRUE per-call latency", async () => {
    const meter = createCaseMeter(fakeModel(), fakeClock());
    await meter.port.complete({ messages: [] });
    await meter.port.complete({ messages: [] });
    const evs = meter.events();
    expect(evs).toHaveLength(2);
    expect(evs[0]!.kind).toBe("model_call");
    expect(evs[0]!.model).toBe("gemini-test");
    expect(evs[0]!.inputTokens).toBe(100);
    expect(evs[0]!.outputTokens).toBe(20);
    expect(evs[0]!.latencyMs).toBe(50);
  });

  it("two concurrent meters do not cross-attribute (the run pool grades 8 cases at once)", async () => {
    const model = fakeModel();
    const a: CaseMeter = createCaseMeter(model, fakeClock());
    const b: CaseMeter = createCaseMeter(model, fakeClock());
    await Promise.all([
      a.port.complete({ messages: [] }),
      b.port.complete({ messages: [] }),
      b.port.complete({ messages: [] }),
    ]);
    expect(a.metrics().modelCalls).toBe(1);
    expect(b.metrics().modelCalls).toBe(2);
  });
});

describe("caseReportFields — AC1: every row of reports/full-eval-report.json carries latencyMs + tokens", () => {
  it("shapes a per-case report row with latencyMs, tokens, modelCalls and turns", async () => {
    const meter = createCaseMeter(fakeModel(), fakeClock());
    await meter.port.complete({ messages: [] });
    await meter.port.complete({ messages: [] });
    const row = caseReportFields(meter, 2);
    expect(row.latencyMs).toBe(100);
    expect(row.tokens).toEqual({ input: 200, output: 40, total: 240 });
    expect(row.modelCalls).toBe(2);
    expect(row.turns).toBe(2);
    expect(row.events).toHaveLength(2);
  });

  it("survives the writer's strip of the bulky per-call `events` detail", async () => {
    const meter = createCaseMeter(fakeModel(), fakeClock());
    await meter.port.complete({ messages: [] });
    // Exactly what eval-full.ts does when it builds the lean report rows.
    const { events, ...lean } = { id: "AC-1", pass: true, ...caseReportFields(meter, 1) };
    expect(events).toHaveLength(1);
    expect(lean).toMatchObject({ latencyMs: 50, tokens: { input: 100, output: 20, total: 120 }, modelCalls: 1, turns: 1 });
    expect(JSON.parse(JSON.stringify(lean))).toHaveProperty("tokens.total", 120);
  });

  it("a case that produced no model call reports 0, not undefined (the row is always present)", () => {
    const row = caseReportFields(createCaseMeter(fakeModel(), fakeClock()), 1);
    expect(row.latencyMs).toBe(0);
    expect(row.tokens.total).toBe(0);
    expect(row.modelCalls).toBe(0);
  });
});

describe("aggregate — the run-level roll-up", () => {
  it("computes p50/p95 with the SAME semantics as platform-ports percentile()", async () => {
    // Four calls at 10/20/30/40ms. percentile(): idx = min(len-1, floor(p/100 * len)).
    //   p50 -> floor(0.5*4) = 2 -> 30ms;  p95 -> floor(0.95*4) = 3 -> 40ms.
    const events = [10, 20, 30, 40].map((latencyMs) => ({
      kind: "model_call" as const,
      model: "mock",
      inputTokens: 1,
      outputTokens: 1,
      latencyMs,
    }));
    const m = aggregate(events, 4, PLACEHOLDER_MODEL_PRICES);
    expect(m.latencyP50Ms).toBe(30);
    expect(m.latencyP95Ms).toBe(40);
  });

  it("returns NULL p50/p95 on an empty set — never NaN, never 0", () => {
    const m = aggregate([], 0, PLACEHOLDER_MODEL_PRICES);
    expect(m.latencyP50Ms).toBeNull();
    expect(m.latencyP95Ms).toBeNull();
    expect(m.modelCalls).toBe(0);
    expect(m.tokens.total).toBe(0);
    // Same discipline for the derived per-turn figure: 0 turns has no answer, so it is null, not 0/NaN.
    expect(m.tokensPerTurn).toBeNull();
    expect(Number.isNaN(m.tokensPerTurn as number)).toBe(false);
  });

  it("computes tokens/turn over TURNS (a turn can cost more than one model call)", () => {
    const events = [1, 2, 3].map(() => ({
      kind: "model_call" as const,
      model: "mock",
      inputTokens: 100,
      outputTokens: 50,
      latencyMs: 5,
    }));
    const m = aggregate(events, 2, PLACEHOLDER_MODEL_PRICES); // 3 calls across 2 shopper turns
    expect(m.tokens).toEqual({ input: 300, output: 150, total: 450 });
    expect(m.modelCalls).toBe(3);
    expect(m.turns).toBe(2);
    expect(m.tokensPerTurn).toBe(225);
  });

  it("reports unpriced:true for a model with no price entry, and does NOT invent a dollar figure", () => {
    const m = aggregate(
      [{ kind: "model_call", model: "gemini-2.5-flash", inputTokens: 1000, outputTokens: 1000, latencyMs: 1 }],
      1,
      PLACEHOLDER_MODEL_PRICES,
    );
    expect(m.unpriced).toBe(true);
    expect(m.unpricedModels).toEqual(["gemini-2.5-flash"]);
    expect(m.costUsd).toBe(0); // a lower bound, flagged — never a fabricated number
  });

  it("reports unpriced:false when every model seen IS in the versioned price table", () => {
    const m = aggregate(
      [{ kind: "model_call", model: "mock", inputTokens: 1000, outputTokens: 1000, latencyMs: 1 }],
      1,
      PLACEHOLDER_MODEL_PRICES,
    );
    expect(m.unpriced).toBe(false);
    expect(m.unpricedModels).toEqual([]);
    expect(m.costUsd).toBe(0); // the mock adapter is genuinely $0
  });

  it("derives USD from an operator-supplied price table instead of hardcoding prices", () => {
    const m = aggregate(
      [{ kind: "model_call", model: "priced-model", inputTokens: 1_000_000, outputTokens: 1_000_000, latencyMs: 1 }],
      1,
      { "priced-model": { inputPer1M: 0.3, outputPer1M: 2.5 } },
    );
    expect(m.unpriced).toBe(false);
    expect(m.costUsd).toBeCloseTo(2.8, 10);
  });
});

describe("the fake-model pipeline end to end (AC3 — no creds, no network)", () => {
  it("meters a multi-call case and rolls it up into the printable run summary", async () => {
    const meter = createCaseMeter(fakeModel({ model: "mock" }), fakeClock());
    for (let i = 0; i < 3; i++) await meter.port.complete({ messages: [] });

    const caseM = meter.metrics();
    expect(caseM.latencyMs).toBe(150);
    expect(caseM.tokens.total).toBe(360);

    const run = aggregate(meter.events(), 3, PLACEHOLDER_MODEL_PRICES);
    expect(run.latencyP50Ms).toBe(50);
    expect(run.latencyP95Ms).toBe(50);
    expect(run.tokensPerTurn).toBe(120);
    expect(run.unpriced).toBe(false);

    const out = formatRunMetrics(run);
    expect(out).toMatch(/p50/);
    expect(out).toMatch(/p95/);
    expect(out).toMatch(/tokens\/turn/);
    expect(out).toMatch(/unpriced: (true|false)/);
  });

  it("prints an honest placeholder rather than '0ms' when nothing was measured", () => {
    const out = formatRunMetrics(aggregate([], 0, PLACEHOLDER_MODEL_PRICES));
    expect(out).toMatch(/n\/a/);
    expect(out).not.toMatch(/NaN/);
  });
});

describe("AC5 — this module MEASURES ONLY; it gates nothing", () => {
  it("exports no threshold, gate, or pass/fail decision (thresholds land in a later PR)", () => {
    const names = Object.keys(metrics);
    expect(names.length).toBeGreaterThan(0);
    // Split camelCase into WORDS before matching, so "aggregate" is not read as a gate but a real
    // "latencyGate"/"costThreshold" export would be caught.
    const banned = ["gate", "gates", "gating", "threshold", "thresholds", "blocked", "pass", "fail", "verdict"];
    const gateish = names.filter((n) =>
      n
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^a-z]+/)
        .some((w) => banned.includes(w)),
    );
    expect(gateish).toEqual([]);
  });

  it("no exported value is a threshold number for latency or cost", () => {
    for (const [name, v] of Object.entries(metrics)) {
      expect(typeof v, `${name} should be a function/type, not a constant threshold`).not.toBe("number");
    }
  });
});
