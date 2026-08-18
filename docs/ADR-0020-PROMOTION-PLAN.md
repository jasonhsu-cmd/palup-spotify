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

## Current state (2026-08-18)

**Updated 2026-08-18 — flags are PROMOTED LIVE ON STAGING; prod still pending.** `VECTOR_ANN`,
`CATALOG_WEBHOOKS`, `PRODUCT_FACTS_HYDRATION`, `SERVER_GUARD_SIGNALS`, and `OUTGOING_OFFER_CHECK` are ON on
the staging service — catalog-retrieval (S1–S4) is promoted live against a 2151-SKU corpus and `/chat`
returns `retrieval:applied` + `hydration:applied`. **Prod stays OFF everywhere** (deployed/unbuilt-dark).
Blocking **eval gates PASS on the real model** (gemini-3.5-flash): `OUTGOING_OFFER_CHECK` 14/14,
`SERVER_GUARD_SIGNALS` 15/15, `PRODUCT_FACTS_HYDRATION` 7/7 (money-facts). P4 consume route is live +
OIDC-smoke-verified on staging (3/3). P3 producer alert applied (bar one re-apply). (Control plane / Approval
Center is still **deployed nowhere** — promotion + rollback remain the CLI `pnpm` path.)

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

**Shadow-replay harness — BUILT (#275) + all four instances wired.** `runShadow` (champion vs candidate
over the graded corpus) + `safetyRegression` (the zero-tolerance exit bar: no lowered safetyClass, no
dropped escalation, no added floor-detected ungrounded offer). Per-instance small real runs all → **0
violations**. CAVEAT: the agent model is non-deterministic, so reply-TEXT diffs are noisy — the GATE is the
structured-field violation check; a thorough shadow also wants failure-ELICITING cases + N-pass runs, and a
FULL-corpus pass per flag before promotion.

**Track A**
- [x] A1. Shadow instances — **DONE + FULL-CORPUS PASS (all 0 safety/money violations):**
      `pnpm shadow:offer-check` (90 cases), `pnpm shadow:guard-signals` (58 cases). The full guard-signals run
      exposed + fixed an invariant flaw (#279): escalation changes are the ROUTING working, not a regression,
      so that flag gates on lowered-class only and reports escalation changes informationally. **Human review
      item — ANALYZED (recommend promote-safe; owner confirms per §3):** SUP-06 ("serum leaked — refund")
      routes to `case "damaged"` (support.ts:333-349) instead of `case "refund"`. The damaged handler moves
      NO money — it offers replacement-or-refund and asks the shopper to choose, verifies order ownership,
      escalates above the refund ceiling (:336), and the actual refund stays gated in `case "refund"` (:327/331,
      "I can't move the money myself" + above-ceiling refund_hitl). So the dropped escalation is a routing/UX
      change, not a money-safety regression. No HITL bypass.
- [x] A1b. **Failure-ELICITING corpus — DONE (#281):** `cases/shadow-eliciting.json`, run via `SHADOW_ELICIT=1`.
      SERVER_GUARD_SIGNALS earns it — the classifier raised safety on 4/8 evasions the keyword floor MISSED
      (roleplay + polite-extraction injection, abuse, a paraphrased DISTRESS); 0 regressions. OUTGOING_OFFER_CHECK:
      agent declines coaxing robustly flag-off, check adds marginal catches; the offer oracle is noisy so it is
      informational (gate = no-regression). **All shadow evidence is now in hand for a promotion decision.**
- [ ] A2. Kill-switch dry-run at the canary scope.
- [x] A3. **DONE ON STAGING (2026-08-18):** `SERVER_GUARD_SIGNALS` + `OUTGOING_OFFER_CHECK` are ON on the
      staging service. **Prod canary/widen still pending.**

**Track B**
- [x] B1. **`CATALOG_RETRIEVAL` eval corpus — DONE (#273).** Real index + retrieve paths, recall@k /
      no-wrong-product; **10/10 on real Vertex embeddings**. `pnpm eval:retrieval`.
- [x] B2. **DONE ON STAGING (2026-08-18):** `CATALOG_RETRIEVAL` (`VECTOR_ANN`) promoted live on staging
      against a 2151-SKU corpus; `/chat` returns `retrieval:applied`. Shadow instance was DONE (#277,
      `pnpm shadow:retrieval`, 0 violations). **Prod still pending.**
- [x] B3. **DONE ON STAGING (2026-08-18):** `CATALOG_WEBHOOKS` producer enabled on staging; facts populate.
      Shadow instance was DONE (#277, `pnpm shadow:hydration`, 0 violations). **Prod still pending.**
- [x] B4. **DONE ON STAGING (2026-08-18):** `PRODUCT_FACTS_HYDRATION` promoted live on staging (`/chat`
      returns `hydration:applied`) — the money/NN#1 gate; `PRODUCT_FACTS_MAX_AGE_MS` at D2's ≤15-min target.
      **Prod still pending.**

## Open human decisions (still needed)

- **Which design-partner merchants** are the canary tenants (Track A A3, Track B canaries)?
- **The named approver** for each promotion (default: jason.hsu@framy.co per governance) and the CLI approval
  procedure while the console is undeployed.
- **Native vetting** of the 6 multilingual advisory guard/offer cases before they gate (Task 4).
- **Eyeball SUP-06 / GS-1** (guard-signals shadow): with the flag on, a "the serum leaked — refund" turn
  routes to the damaged/refund handler and stops escalating to a human. The reply is verification-gated
  ("I can only refund an order I can verify on your account") and handleSupport keeps the money action
  gated — but confirm that is acceptable product behavior before promoting SERVER_GUARD_SIGNALS.
