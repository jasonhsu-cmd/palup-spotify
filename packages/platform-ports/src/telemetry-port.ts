import type { RuntimeStatePort } from "./runtime-state-port.js";
import type { Arm } from "./outcome-ledger.js";

// Telemetry port (ADR-0001 names `telemetry`; ADR-0013 pins the interface). Passive MEASUREMENT of the
// run-time plane — per-request/tenant/agent/model tokens + latency — so cost/margin become visible and
// the §5 model-tiering discipline has real data. It never changes an agent decision and auto-applies
// nothing (any ACTION on this data — throttle, model-downgrade, spend change — stays HITL/Approval-Center
// gated). `record` is fail-open: telemetry must never break or delay serving.
//
// Design boundary (ADR-0013): events carry RAW TOKENS, never dollars. `$ = tokens × price[model]` is
// derived at read from a versioned, operator-provided price table (a drifting world fact), so a price
// correction re-derives history instead of rewriting immutable measurements.

/**
 * The model-tier vocabulary docs/design/model-gateway.md §3 defines: `routine` (Gemini Flash, ~95% of
 * calls) → `high_stakes` (Gemini Pro, ~4%) → `canary` (a gated candidate, ~1%). This is the tier mix the
 * margin engine watches for a routing regression (cost-margin-telemetry.md §4 "Tier-mix protection").
 * Nothing populates it yet — the model gateway itself is design-only (docs/design/model-gateway.md is not
 * a built package) — so its absence on every event today is honest, not a gap this port is hiding.
 */
export type ModelTier = "routine" | "high_stakes" | "canary";

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
  /**
   * Cost-attribution category — the 8-category admin cost stack (docs/design/cost-margin-telemetry.md
   * §1: inference, agent-tax/background, infra, eval & training, media, messaging, growth/S&M, vendor
   * stack). Free-form string, not a closed enum here: the category taxonomy is FinOps-owned and this port
   * only carries whatever the caller states — it never infers or guesses one. Optional, and nothing
   * populates it yet; existing producers (metering.ts, the /chat turn event) are unaffected.
   */
  category?: string;
  /** Which ModelTier this call was routed to. Optional, caller-supplied — see ModelTier above. */
  tier?: ModelTier;
  /**
   * E3 — RECOMMENDATION TELEMETRY: the merchant product ids this turn's reply actually CITED, in the
   * order it cited them (`Decision.recommendedProducts`, widget-brain). Present only on a `"turn"` event,
   * and only when something resolved; the key is omitted entirely otherwise, so a turn that recommended
   * nothing and a turn where the mechanism is off are byte-identical rows.
   *
   * IT IS NOT A BILLING BASIS, and this is the constraint that governs the field rather than a caveat on
   * it. Chaining `recommended -> clicked -> purchased` off these ids is LAST-TOUCH attribution, which
   * ADR-0007 §2 and docs/PRICING.md §2 explicitly forbid as a fee basis ("conservative,
   * incrementality-based attribution ... never last-touch inflation ... the billing form of
   * engagement-maxxing"). Any fee derived from this field would breach that ADR, and doing so would
   * itself be a money/business-model boundary crossing under docs/HITL-POLICY.md. What it IS for:
   * merchant-facing "what did it suggest" reporting, per-product eval grading, and debugging.
   *
   * IT UNDER-COUNTS BY CONSTRUCTION. It is derived from the citation mechanism, so it inherits every one
   * of that mechanism's limits: a model that recommends a product in PROSE without copying its tag
   * produces no entry, and citations are minted only on the clean sales path, so a proactive exit-intent
   * turn reports nothing at all. Absence of an id means "not cited", never "not recommended". Any RATE
   * computed from this measures the model's citation COMPLIANCE, not its recommendation behaviour —
   * which is why `rollupEvents` below deliberately does not aggregate it into the cost rollup: an
   * aggregate over an under-counting field is a number that looks measured and is not.
   *
   * PII-free like every other field here: product ids are merchant catalog identifiers, never shopper
   * data, and no title, price or reply text is carried.
   */
  recommendedProductIds?: string[];
  /**
   * Wave 2 / W2-B — the business HOLDOUT arm this turn was served under ("treated" | "control"), when the
   * holdout is enabled for this tenant (`packages/widget-backend/src/holdout.ts`). Present only on a
   * `"turn"` event and only while the holdout is on; omitted (not `undefined`-valued in the *serialized*
   * wire form, but structurally absent) whenever it is off — the default — so every turn recorded today,
   * and every turn for a tenant that never enables it, is unaffected. PII-free: an arm label, never a
   * shopper/session identifier. NOT a billing basis by itself — see `outcome-ledger.ts`'s own guardrail
   * comment; this field is for observability/join, the actual measurement is `ArmTally`.
   */
  arm?: Arm;
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
  /**
   * The tier-mix (docs/design/cost-margin-telemetry.md §4): events/tokens aggregated by `ModelTier` for
   * every event that carried one. Optional on the TYPE (so a hand-built rollup fixture from before this
   * field existed still satisfies the interface); `rollupEvents` below always SETS it (as `{}` when no
   * event in the window carried a tier — same convention as `byModel`, never omitted vs. fabricated).
   */
  byTier?: Record<string, { events: number; inputTokens: number; outputTokens: number }>;
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
  // `?? null` cannot fire — the empty guard above plus the `length - 1` clamp put `idx` in range for
  // every `p`. It is here because `noUncheckedIndexedAccess` types the read as `number | undefined` and
  // the honest way to reconcile that with the `number | null` return is a widening, not an assertion.
  return sortedAsc[idx] ?? null;
}

export function rollupEvents(tenantId: string, events: TelemetryEvent[]): TelemetryRollup {
  const byModel: Record<string, { events: number; inputTokens: number; outputTokens: number }> = {};
  const byTier: Record<string, { events: number; inputTokens: number; outputTokens: number }> = {};
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
    if (e.tier) {
      const t = (byTier[e.tier] ??= { events: 0, inputTokens: 0, outputTokens: 0 });
      t.events++;
      t.inputTokens += e.inputTokens ?? 0;
      t.outputTokens += e.outputTokens ?? 0;
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
    byTier,
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
