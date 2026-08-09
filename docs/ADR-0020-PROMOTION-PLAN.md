# ADR-0020 promotion plan (Task 5)

> The ordered, governed path to enabling the ADR-0020 run-time flags. Companion to
> `docs/A1B-A3-GO-LIVE-CHECKLIST.md` (which holds the A1b/A3 stage detail) and bound by the pipeline in
> CLAUDE.md §3.2: `eval gate → shadow(0%) → canary(1–5%) → human approve → promote → monitored`, with
> automatic rollback. **Nothing here auto-applies; every stage transition is a named-human action.**

## Reality of the stages (control plane is deployed nowhere)

- **shadow** = staging + traffic-replay against `reports/` / `.palup-state/` graded transcripts — NOT a live
  0% splitter. Tell any approver this; do not imply a live splitter exists.
- **canary** = the flag scoped to 1–3 low-volume design-partner merchants (env/config per tenant).
- **approve** = the CLI path (`pnpm` jobs) while the Approval Center console is undeployed.
- **rollback** = flip the flag off + the Kill Switch at the affected scope.

## Current state (2026-08-09)

All ADR-0020 flags OFF everywhere. Blocking **eval gates PASS on the real model** (gemini-3.5-flash):
`OUTGOING_OFFER_CHECK` 14/14, `SERVER_GUARD_SIGNALS` 15/15, `PRODUCT_FACTS_HYDRATION` 7/7 (money-facts). P4
consume route is live + OIDC-smoke-verified on staging (3/3). P3 producer alert applied (bar one re-apply).

## Dependency graph

```
Track A (independent, eval ✅ — promotable now):
  OUTGOING_OFFER_CHECK        (fail-safe to the keyword floor; +1 model call/sales turn)
  SERVER_GUARD_SIGNALS        (producer+consumer atomic on the flag; can only RAISE safety / ROUTE)

Track B (money/NN#1 chain):
  CATALOG_RETRIEVAL           (wave-4; NO eval corpus yet — THE blocker; hydration fires only on the
        ↓                      retrieved subset)
  CATALOG_WEBHOOKS            (chosen producer — P4 durable path, already smoke-verified; populates facts)
        ↓
  PRODUCT_FACTS_HYDRATION     (serves fresh prices; eval 7/7 but inert until the two above are on)
```

Facts about the wiring (verified in `server.ts`): the guard classifier runs ONLY when `SERVER_GUARD_SIGNALS`
is on (:2030), so no wasted spend off. Hydration requires `CATALOG_RETRIEVAL` (the retriever narrows to the
subset it hydrates) AND a producer that has populated `ProductFactsPort` (else `getMany` is empty → inert).

## Locked decisions (2026-08-09)

1. **Sequence both tracks in parallel** — drive Track A through shadow→canary while building Track B's
   `CATALOG_RETRIEVAL` eval corpus.
2. **Producer = `CATALOG_WEBHOOKS` directly** (skip `PRODUCT_FACTS_POLL`) — the P4 durable path is
   smoke-verified; real-time freshness. (The scheduled poll job remains the missed-event backstop.)
3. **Build the `CATALOG_RETRIEVAL` eval corpus now** — it is the hard blocker for the whole hydration chain.

## Per-flag recipe (run every time)

1. **Eval gate green** — done for the 3; `CATALOG_RETRIEVAL` needs a corpus (recall@k, no-wrong-product,
   no-silent-truncation) before it may enter any live stage.
2. **Shadow** — replay graded transcripts with the flag on. Exit bar: zero fabricated/stale prices, zero
   lowered safety classes, added latency within budget.
3. **Kill-switch dry-run** at the target scope (NN#4) BEFORE canary — arm/disarm per tenant/agent.
4. **Canary** — enable on 1–3 design-partner tenants; a human reads the Audit Log + P3 alert daily over a
   fixed window (e.g. 1 week).
5. **Auto-rollback triggers** — any fabricated-price audit hit, a stale-quote, a safety/guardrail regression,
   or a cost-cap breach from the extra model calls.
6. **Named-human approval → widen → monitored.**

## Ordered action list

**Track A**
- [ ] A1. Shadow-replay `OUTGOING_OFFER_CHECK` + `SERVER_GUARD_SIGNALS` against the graded corpus (build the
      replay harness if one does not already exist under `packages/eval`).
- [ ] A2. Kill-switch dry-run at the canary scope.
- [ ] A3. Canary on 1–3 design-partner tenants; monitor; human approve; widen.

**Track B**
- [ ] B1. **Build the `CATALOG_RETRIEVAL` eval corpus** (recall@k / no-wrong-product / no-silent-truncation).
- [ ] B2. Promote `CATALOG_RETRIEVAL` (eval → shadow → canary → approve).
- [ ] B3. Enable `CATALOG_WEBHOOKS` producer in staging shadow (P4 consume route is ready); confirm facts
      populate + the P3 alert stays quiet; do the push-SA 204 delivery check (grant tokenCreator or observe a
      real push).
- [ ] B4. Promote `PRODUCT_FACTS_HYDRATION` (eval ✅ → shadow → canary → approve) — the money/NN#1 gate; tune
      `PRODUCT_FACTS_MAX_AGE_MS` against D2's ≤15-min freshness target.

## Open human decisions (still needed)

- **Which design-partner merchants** are the canary tenants (Track A A3, Track B canaries)?
- **The named approver** for each promotion (default: jason.hsu@framy.co per governance) and the CLI approval
  procedure while the console is undeployed.
- **Native vetting** of the 6 multilingual advisory guard/offer cases before they gate (Task 4).
