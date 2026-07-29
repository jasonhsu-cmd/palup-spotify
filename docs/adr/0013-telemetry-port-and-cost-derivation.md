# ADR-0013: Telemetry port + cost derivation (raw tokens now, dollars at read)

- **Status:** Accepted (implementation in progress — M3; the authoritative price table + a real revenue
  signal are human inputs, see Consequences)
- **Context:** PalUp's margin story and the model-tiering discipline (`CLAUDE.md` §5) need real
  per-request / per-tenant / per-agent **cost, latency, and margin** data. The raw material already
  exists — `ModelResponse.usage {inputTokens, outputTokens}` (`model-port.ts`), populated by the Vertex
  adapter — but nothing captured it, and ADR-0001 only *names* a `telemetry` port. This ADR pins the
  port's shape and the one durable design decision that outlives any adapter: **how cost is derived**.
  It is deliberately narrow: telemetry is passive MEASUREMENT; acting on it (throttle, model-downgrade,
  spend change) is a separate, HITL/Approval-Center-gated concern (`HITL-POLICY.md`, and the cost
  circuit-breaker in `cost-margin-telemetry.md`), out of scope here.

## Decision

1. **A vendor-neutral `TelemetryPort`** (`record(ctx, event)` fail-open + `query(ctx)` → rollup),
   realizing ADR-0001's named `telemetry` port. Feature code depends on the port; the first adapter
   writes to the `RuntimeStatePort` (tenant-isolated append stream, no new dependency), and an
   OpenTelemetry / cloud adapter swaps in later behind the same port (`observability-and-sre.md`).

2. **Capture at the model-port boundary via a metering decorator** (`createMeteringModelPort`, mirroring
   `createRedactingModelPort`) — the single, unbypassable choke point for token usage + model-call
   latency + the model id, attributed to the **server-derived** `ModelRequest.tenantId`. A per-turn
   `/chat` enrichment event adds the business dimensions the decorator can't see (mode, pitch, servedBy,
   end-to-end latency). Both are **fail-open / fire-and-forget** — telemetry can never delay or break
   serving.

3. **Events carry RAW TOKENS, never dollars.** `$ = tokens × price[model]` is derived at **read** from a
   versioned, operator-provided price table. This decouples the drifting world-fact (price) from the
   immutable measurement: a price correction re-derives history instead of rewriting events. The mock
   model is `$0`; an unknown model is flagged, never silently priced.

4. **PII-free by construction.** Telemetry events carry only counters + short enum/id identifiers
   (tenant, agentType, model, tokens, latency, policy id, mode, pitch enum, escalate). No raw shopper
   message/reply, no PII, no secret ever enters an event. This is a review-enforced invariant.

5. **Measurement-only; not an autonomous action.** Telemetry records and aggregates; it moves no money
   and changes no agent behavior, so it does **not** trip HITL and is **not** written to the immutable
   Audit Log (which is for autonomous actions, NN#5). The moment this data drives an action, that action
   routes through HITL + Approval Center + audit.

6. **Retention is a rolling window.** The telemetry stream is trimmed (bounded growth), so rollups
   aggregate the retained window, not lifetime. The cost read surface must treat cumulative dollars as a
   rolling window (or roll-up-and-persist before trim) — it is not a billing ledger. Billing-grade
   attribution/metering lives in ADR-0007.

## Alternatives considered

- **Store dollars in the event (derive at write).** Rejected — bakes a drifting, unverified world-fact
  into immutable history; a price fix would require rewriting events.
- **Capture only in `/chat`.** Rejected — the brain makes multiple model calls per turn and a future
  non-`/chat` caller would be invisible; the decorator is bypass-proof. `/chat` is kept only for the
  business dimensions it uniquely knows.
- **`incrementWindow` counters as the store.** Rejected — resetting fixed windows give no p50/p95 and no
  clean cumulative rollup; the raw sample set is needed for percentiles.
- **Fold into ADR-0007.** Rejected — ADR-0007 governs billing metering/attribution/margin (revenue
  side); the operational cost/latency port + the tokens-vs-dollars boundary are a distinct, cross-cutting
  decision. This ADR references, and does not duplicate, ADR-0007.

## Consequences

- (+) Per-request/tenant/agent/model cost + latency are visible; portable behind the port (OTel/cloud
  adapter later); measurement never risks serving (fail-open) or leaks PII.
- (+) A price correction re-derives all history; the immutable measurement is never rewritten.
- (−) **Margin's revenue side does not exist yet** — attributed revenue is the ADR-0007 outcome ledger
  (governed, not built). Until it lands, the read surface shows **COGS + latency**, and margin renders
  "revenue: unavailable", never a fabricated number.
- (−) The **authoritative price table** (per model id, with source + date) is a **human/FinOps input** —
  current Vertex/Gemini token prices are an unverified, region/model-specific, drifting world fact and
  must not be hardcoded as a guess (`create.ts` already flags the model id + `usageMetadata` field names
  as UNVERIFIED-LIVE). Ships with a clearly-marked placeholder until provided.
- (−) The operator read endpoint (a later slice) must not rely on the control plane's current open-GET
  posture — cost data is sensitive and requires an explicit operator-auth check; requires
  `security-reviewer` sign-off.
