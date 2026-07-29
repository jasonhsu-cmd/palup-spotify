import type { RuntimeStatePort } from "./runtime-state-port.js";

// Telemetry port (ADR-0001 names `telemetry`; ADR-0013 pins the interface). Passive MEASUREMENT of the
// run-time plane — per-request/tenant/agent/model tokens + latency — so cost/margin become visible and
// the §5 model-tiering discipline has real data. It never changes an agent decision and auto-applies
// nothing (any ACTION on this data — throttle, model-downgrade, spend change — stays HITL/Approval-Center
// gated). `record` is fail-open: telemetry must never break or delay serving.
//
// Design boundary (ADR-0013): events carry RAW TOKENS, never dollars. `$ = tokens × price[model]` is
// derived at read from a versioned, operator-provided price table (a drifting world fact), so a price
// correction re-derives history instead of rewriting immutable measurements.

export interface TelemetryEvent {
  /** "model_call" from the model-port metering decorator; "turn" from the /chat per-turn enrichment. */
  kind: "model_call" | "turn";
  agentType?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  servedBy?: string; // canary/champion policy id
  mode?: string;
  pitch?: string;
  escalate?: boolean;
  /** ISO timestamp; stamped by the adapter on record if the caller omits it. */
  at?: string;
}

export interface TelemetryRollup {
  tenantId: string;
  events: number;
  inputTokens: number;
  outputTokens: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  byModel: Record<string, { events: number; inputTokens: number; outputTokens: number }>;
}

export interface TelemetryPort {
  /** Record one telemetry event for a tenant. FAIL-OPEN — never throws to / delays the caller. */
  record(ctx: { tenantId: string }, event: TelemetryEvent): Promise<void>;
  /** Aggregate the retained events for a tenant (the operator/merchant read surface). */
  query(ctx: { tenantId: string }, opts?: { limit?: number }): Promise<TelemetryRollup>;
}

const STREAM = "telemetry"; // per-tenant append stream on the RuntimeStatePort

function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
  return sortedAsc[idx];
}

export function rollupEvents(tenantId: string, events: TelemetryEvent[]): TelemetryRollup {
  const byModel: Record<string, { events: number; inputTokens: number; outputTokens: number }> = {};
  let inputTokens = 0;
  let outputTokens = 0;
  const latencies: number[] = [];
  for (const e of events) {
    inputTokens += e.inputTokens ?? 0;
    outputTokens += e.outputTokens ?? 0;
    if (typeof e.latencyMs === "number") latencies.push(e.latencyMs);
    if (e.model) {
      const m = (byModel[e.model] ??= { events: 0, inputTokens: 0, outputTokens: 0 });
      m.events++;
      m.inputTokens += e.inputTokens ?? 0;
      m.outputTokens += e.outputTokens ?? 0;
    }
  }
  latencies.sort((a, b) => a - b);
  return {
    tenantId,
    events: events.length,
    inputTokens,
    outputTokens,
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    byModel,
  };
}

/**
 * First TelemetryPort adapter — writes events to a tenant-scoped append stream on the RuntimeStatePort
 * (tenant isolation rides on the store's guarantee; no new dependency). An OTel/Cloud adapter is a later
 * implementation behind the same port. Rollups compute at read over the retained window; retention is
 * bounded by trimStream in the serving path's reclamation block (a later slice).
 */
export function createStoreTelemetry(store: RuntimeStatePort): TelemetryPort {
  return {
    async record(ctx, event) {
      try {
        await store.append({ tenantId: ctx.tenantId }, STREAM, { ...event, at: event.at ?? new Date().toISOString() });
      } catch {
        /* fail-open — telemetry can never break serving */
      }
    },
    async query(ctx, opts) {
      const events = await store.readStream<TelemetryEvent>({ tenantId: ctx.tenantId }, STREAM, opts).catch(() => []);
      return rollupEvents(ctx.tenantId, events);
    },
  };
}
