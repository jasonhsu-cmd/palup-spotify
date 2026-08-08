# A1b + A3 (fresh-price serving) — go-live / promotion checklist

> **Status: NOT READY — build preconditions P1–P4 are OPEN.** This is the single gate list for enabling
> the ADR-0020 Workstream-A fresh-price pipeline in a real environment. Every flip is a **named-human
> promotion** (CLAUDE.md §3, HITL-POLICY §5): `PRODUCT_FACTS_HYDRATION` in particular changes the PRICE a
> shopper is quoted (money/NN#1). No build agent performs a flip, and no amount of green CI substitutes for
> the human approvals below.

**What the flips actually do.** Everything is merged and **inert** — five posture flags default OFF and the
serving path is byte-identical to before. Enabling them, in order, turns on: producing fresh Tier-2
price/availability facts, then serving them in place of the 30-min-cached catalog price.

**How to read this list.** Each item is **MET** (with evidence), **OPEN** (with what's missing), or
**ACCEPT** (a residual risk consciously signed off). "In a PR" is *not* met — merged and verified is met.

_Last updated: 2026-08-08._

---

## The dependency order (flip in this sequence; each is inert/meaningless without the prior)

1. `PRODUCT_FACTS_POLL` (A3-poll producer) — populates the store; changes nothing shopper-facing alone.
2. `CATALOG_RETRIEVAL` (pre-existing Wave-4 flag) — **prerequisite for A1b**: hydration overlays only onto
   the retrieved subset, so with retrieval off, `PRODUCT_FACTS_HYDRATION` does nothing. If not already
   promoted, it is its own gate (own eval/shadow/canary), not covered here.
3. `PRODUCT_FACTS_HYDRATION` (A1b serving) — **the money/NN#1 step**: changes the quoted price.
4. `CATALOG_WEBHOOKS` (A3-part-2 real-time producer) — optimization atop the poll path.

---

## A. Build preconditions (BLOCKERS — code that must land + be reviewed before the live stages)

| # | Item | Status | Blocks |
|---|------|--------|--------|
| P1 | **D2 staleness ceiling.** A1b's overlay must ignore/refuse a fact older than a hard ceiling and make the agent say *"let me confirm current price/availability"* rather than quote a stale number. | **MET** — `hydrateProductFacts` takes a `HydrationStaleness` ceiling; a fact past it (or with no/malformed `updatedAt`) is not quoted → the product renders `priceConfirmed:false`, and BOTH the CATALOG line AND the E3 card withhold the number (the card carries the same "current price needs confirming" sentinel + `priceConfirmed:false`, so the prompt and the card can't diverge — the money/NN#1 leak the P1 security review caught). `PRODUCT_FACTS_MAX_AGE_MS` (default 1h) tunes it. Unit + serving + card-path tests; flag-off byte-identical. | — |
| P2 | **Audit-log the facts `upsertMany`** (A3 producer) — once served, these are shopper-quoted money facts; §5 wants the write in the immutable audit log. | **MET** — each successful facts write records a `catalog.product_facts` audit entry (actor, count, source, reversalPath) via `store.audit`; a rare audit-after-write failure is itself alerted (P3). Non-atomic with the vector write (separate ports), stated in code. Tested. | `PRODUCT_FACTS_HYDRATION` canary |
| P3 | **Producer failure metric + alert** — a silently-failing producer = facts quietly going stale (today only `console.error`). | **MET (code) + IaC written; apply OPEN** — the code raises a stably-keyed `ALERT product_facts_{upsert,audit}_failed` marker (tested), and `infra/terraform/monitoring.tf` defines the log-based metric + alert policy on it. **Remaining human step:** `terraform apply` with GCP creds + a notification channel (never auto-applied; not gate-validated — terraform absent from CI). | `PRODUCT_FACTS_POLL` canary |
| P4 | **Async QueuePort adapter** (Cloud Tasks / Pub-Sub) — the in-memory queue reconciles synchronously in-request and exceeds Shopify's webhook timeout. | OPEN | `CATALOG_WEBHOOKS` shadow |

## B. Eval gate (the blocking static gate — before ANY traffic)

Runs on `pnpm eval:full` (judge-graded, real model) with a **new money-facts eval layer**. Must pass
before shadow — no shopper traffic on a candidate that fails statically (§3.2).

- **Ground truth:** a fixture of `(tenant, productId, current price, availableForSale, updatedAt)` + shopper
  turns asking about each, plus **stale** and **missing-fact** variants.
- **Gating metrics (proposals — calibrate against the incumbent baseline first):**
  - **Price-fidelity ≥ 99%** — quoted price exactly matches the current fact (or the base catalog price when
    no fact). A single fabricated/converted number fails.  → **OPEN**
  - **Staleness fail-honest = 100%** — every past-ceiling fixture yields "let me confirm," never a stale
    quote (tests P1).  → **OPEN**
  - **Availability fidelity = 100%**, three-state preserved.  → **OPEN**
  - **Cross-tenant isolation** — tenant A's turn never surfaces tenant B's fact.  → **OPEN**
  - **No-regression** — safety floor, voice, compliance suites stay ≥ current bars (the standing gate).

## C. Shadow (0% — no shopper sees it)

- Candidate posture runs in parallel with the champion; its reply is **discarded** (logged, not served).
- Compare per turn: price deltas, staleness triggers, added latency from the `getMany` hydrate call.
- Exit: ≥ a chosen turn count with **zero fabricated prices**, latency within budget, P1 fail-honest firing
  where expected.
- **HONEST CAVEAT:** the control-plane canary surface is **built but deployed nowhere** (CLAUDE.md §6), so
  "shadow" is realistically a **staging + traffic-replay** run against `reports/`/`.palup-state/`
  transcripts, NOT a live 0% split. The approver must be told this; do not imply a live splitter exists.

## D. Canary (1–5%)

- Smallest real exposure: enable per-tenant on **1–3 low-volume design-partner merchants** (flags are
  env/config, so canary = a scoped rollout, not a % splitter we have infra for).
- **Auto-rollback triggers:** any fabricated-price audit hit; a staleness-quote detected; error-rate/latency
  regression; a cost-cap breach from the extra hydrate/producer calls.
- **Kill switch verified** for this scope before canary starts (NN#4) — arm/disarm dry-run per tenant.
- A human reviews the audit + telemetry daily over a fixed window (e.g. 1 week).

## E. Promote → 100% → monitored

- Named-human approval (Approval Center, or the CLI equivalent while the console is undeployed).
- Progressive widen; same triggers as canary + automatic rollback on regression.

## F. Rollback

- Every stage: **flip the flag off** → instant revert to the byte-identical inert baseline (the point of the
  inert design; no data migration to undo — the store simply stops being read).
- `deleteTenant` on the fact/presentment stores is the data-erasure path if needed.

## G. HITL / audit

- Each stage transition is a **named-human decision**, recorded. The money/NN#1 boundary (A1b) most needs
  the Approval Center trail.
- **Co-enablement sign-off:** A1b + `SERVER_GUARD_SIGNALS` + `SUBSCRIPTION_SELFSERVE` together carry the
  separately-recorded sign-off (from the broaden security review — the English-only auto-skip guard).
