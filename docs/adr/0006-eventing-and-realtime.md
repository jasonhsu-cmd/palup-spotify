# ADR-0006: Eventing and real-time delivery

- **Status:** Accepted
- **Context:** Both consoles have many **live surfaces**: the Approval Center ("N to approve"
  updating as proposals arrive), the Inbox ("live now", 4s replies), the Engineering/Business
  monitors, the Event Center, Kill Switch state, and per-screen counters. The agent runtime
  (ADR-0005) is trigger-driven and produces a continuous stream of domain changes. We need one
  eventing design that (a) drives agent work, (b) pushes live updates to the consoles, and (c)
  scales per-tenant to millions of tenants without a Google-only dependency.

## Decision

1. **One internal event backbone behind the `queue` port.** Domain changes are published as
   immutable events (`proposal.created`, `cart.abandoned`, `message.received`, `run.completed`,
   `killswitch.armed`, `eval.regressed`, …), keyed by `merchant_id` (or `org` for PalUp-plane
   events). The Google adapter is Pub/Sub today; the port keeps it swappable (ADR-0001).
2. **Events are the seam between planes.** Triggers enqueue agent runs (ADR-0005); the monitoring
   plane consumes the same stream for telemetry/self-heal; the control plane consumes it for live
   console updates. Producers never call consoles directly.
3. **Console push via SSE (default) / WebSocket (interactive takeover).** The console API service
   subscribes per authenticated session to the tenant/role-scoped slice of the stream and pushes
   updates over Server-Sent Events; live-chat **take-over** (bidirectional) uses WebSocket. A
   session only ever receives events its RBAC scope permits (`docs/SECURITY.md`; the admin nav is
   role-gated, the ask-bar inherits the matrix).
4. **Delivery contract: at-least-once + idempotent consumers.** Webhooks and internal events retry;
   every consumer (agent runs, projections, push) dedups on event id and is replay-safe. Ordering
   is guaranteed only **per tenant key**, which is all the product needs.
5. **Read models / projections for counters.** Live counters ("312 resolved today", "N to approve",
   monitor KPIs) are served from per-tenant projections updated off the event stream, not computed
   by scanning base tables — required for the list sizes in the UI.
6. **Back-pressure and fan-out limits.** Per-tenant fan-out is bounded; a slow or disconnected
   console consumer never blocks agent work or other tenants. Monitoring-plane firehose consumers
   run on their own subscription with their own scaling.

## Alternatives considered

- **Console polls REST endpoints.** Simplest. Rejected as the primary mechanism — polling at this
  tenant/among these live surfaces is wasteful and laggy; kept only as an SSE fallback.
- **Direct DB change-data-capture to the browser.** Leaks schema, hard to RBAC-scope safely,
  couples the UI to storage internals. Rejected.
- **Provider-native eventing wired directly into feature code (Pub/Sub SDK everywhere).** Fast but
  violates ADR-0001. Rejected — it goes behind the `queue` port.

## Consequences

- (+) One backbone serves agent triggering, monitoring, and live UI — less plumbing, consistent
  ordering/idempotency guarantees, and it stays portable.
- (+) Real-time surfaces and self-healing monitors are natural consumers; adding a surface is a new
  subscription, not new infrastructure.
- (−) Requires disciplined idempotency and per-tenant keying everywhere; "exactly-once" is not
  offered — consumers must tolerate duplicates.
- (−) Projections add eventual-consistency windows on counters; acceptable for dashboards, and
  money/audit truth still lives in the transactional store, not the projection.
