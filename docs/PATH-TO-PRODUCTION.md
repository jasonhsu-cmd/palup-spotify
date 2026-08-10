# Path to production

> Turns the 2026-08-10 spec-vs-code audit (11-agent, 167 items, citation-verified) into ONE sequenced,
> dependency-aware roadmap. Target milestone: **a first real US-Shopify design-partner merchant serving real
> shoppers from their live storefront**, sales-first. Everything past that is Phase 2+.
>
> **Current state (one line):** a single-tenant *staging* demo page (`packages/widget/public/index.html`) on
> real Gemini + real (demo-store) Shopify grounding, with every money/identity/retrieval posture flag-OFF,
> the control-plane deployed nowhere, and commerce on fixtures. Nothing here is a single flag flip.

## Legend (owner type)

- **[BUILD]** — code I can write test-first (build agents).
- **[INFRA]** — GCP / Shopify infra + credentials; a human runs it, I prepare the exact commands/config.
- **[BIZ/LEGAL]** — a business, pricing, or legal decision only a human can make.

Each item cites the audit evidence so status is verifiable.

---

## The critical path (minimum to serve ONE pilot merchant)

A design-partner pilot can *defer* billing (invoice manually), EU/GDPR-export (US-only pilot), live commerce
(sales-only; support escalates honestly), and the whole self-improve track. What genuinely gates a pilot:

1. **[INFRA] Register the Shopify app** — `shopify app deploy` from a Partners account; the app is not
   registered/listed today (`shopify.app.toml:12-14` exists but was never deployed). *Gates everything below.*
2. **[BUILD] Finish install → embed-key → storefront-token** — the OAuth install records the install and
   custodies a delegate token, but no route hands the merchant an embed key and serving reads the storefront
   token from `SecretsPort`, not the C1 delegate credential, so an OAuth-installed merchant gets fixtures
   (`routes/shopify-install.ts:453,479`; `merchant-store.ts:54-78`). Close that loop so a self-installed
   merchant grounds on THEIR catalog.
3. **[BUILD] The embeddable widget — code complete on `feat/embeddable-widget`, not yet merged to `main`.**
   The theme app extension (`extensions/palup-widget/`), the loader (`packages/widget/src/loader-entry.ts`),
   and the backend routes (`GET /embed/loader.js`, `GET /embed/panel` — `packages/widget-backend/src/
   routes/embed.ts`) are built and tested on that branch. What remains once it merges is [INFRA]:
   `shopify app deploy` (item 1) registers the extension; separately, a human must hand-edit the
   `REPLACE_WITH_APP_HOST` placeholder in `app-embed.liquid` + `shopify.app.toml` to the real app host —
   no build-time substitution exists for it (verified: nothing in the repo's scripts, CI, or package.json
   touches that string). See `docs/DEPLOY.md` *Embedding the widget on a storefront* for the full path and
   the storefront-token caveat (a self-installed merchant still gets fixtures, not their own catalog, until
   item 2 closes).
4. **[INFRA] A production deployment** — no prod workflow or service exists; staging-only
   (`docs/DEPLOY.md:3`; `.github/workflows/`). Stand up a prod Cloud Run service + deploy path, with
   `WIDGET_AUTH_REQUIRED=true` (staging already enforces it via smoke — `server.ts:285`).
5. **[BIZ/LEGAL] Confirm the pilot scope** — sales-first (grounding + pitch + guardrails), commerce actions
   HITL/escalated, no cross-visit memory, US-only. This decision is what lets 6/7/8 below be deferred.

**Serve-a-pilot depends on: 1 → (2, 3 in parallel) → 4, with 5 chosen up front.** That is the whole MVP.

---

## Phase 1 — first pilot merchant (the MVP launch)

| # | Item | Owner | Status (audit) | Blocks on |
|---|------|-------|----------------|-----------|
| 1 | Register Shopify app (`shopify app deploy`) | INFRA | pending — `shopify.app.toml:12-14` | — |
| 2 | Install→embed-key handoff + storefront-token custody | BUILD | in_progress — `shopify-install.ts:453,479` | 1 |
| 3 | Serve merchant's own catalog (D2 fix) | BUILD | pending — `merchant-store.ts:54-78` | 2 |
| 4 | Embeddable widget (theme app extension + loader + `/embed/*` routes) | BUILD | **done (code, on `feat/embeddable-widget`, unmerged)** — `extensions/palup-widget/`, `packages/widget-backend/src/routes/embed.ts`; live traffic still gated on 1 | 1 |
| 5 | Prod Cloud Run service + deploy workflow | INFRA | pending — `docs/DEPLOY.md:3` | — |
| 6 | `WIDGET_AUTH_REQUIRED=true` in prod | INFRA(config) | in_progress — `server.ts:285` | 5 |
| 7 | Human take-over: honest escalation copy OR a real producer | BUILD/BIZ | pending — `brain.ts:1100` | 5 |

Phase-1 exit: a design-partner merchant installs the app, the widget mounts on their storefront, and their
shoppers get grounded, guardrailed, sales-first answers on real Gemini — with support/commerce actions
honestly escalated. Manual invoicing; no memory; US-only.

**Remaining human steps for the embed (2026-08-10):** (a) merge `feat/embeddable-widget` to `main`, then
`shopify app deploy` from a Partners account — registers the app + the `palup-widget` extension; separately,
a human must hand-edit the `REPLACE_WITH_APP_HOST` placeholder (`extensions/palup-widget/blocks/
app-embed.liquid:12`, `shopify.app.toml:25`) to the real host before that deploy is meaningful — nothing in
the repo substitutes it automatically (verified: no script, CI step, or pnpm task touches that string);
(b) standing up a production host (#5 above) so a real host value exists to set. Full detail:
`docs/DEPLOY.md` *Embedding the widget on a storefront*.

## Phase 2 — quality, freshness, scale (mostly already built, gated behind promotion)

This is the ADR-0020 work already done this session — eval gates 4/4, full-corpus + eliciting shadow all 0
violations. What remains is the human promotion path (canary → approve) per `docs/ADR-0020-PROMOTION-PLAN.md`.

| Item | Owner | Status | Note |
|------|-------|--------|------|
| Promote `CATALOG_RETRIEVAL` (E1) | BIZ(approve)+INFRA | in_progress | eval 10/10; needed once a merchant catalog >~1000 SKUs — `server.ts:512` |
| Enable `CATALOG_WEBHOOKS` producer (A3) + `terraform apply` (P3 alert, P4) | INFRA | in_progress | P4 route smoke-verified; env + apply are human — `server.ts:946` |
| Promote `PRODUCT_FACTS_HYDRATION` (A1b, money/NN#1) | BIZ(approve) | in_progress | inert until retrieval + a producer populate facts — `server.ts:527` |
| Promote `SERVER_GUARD_SIGNALS` (safety routing) | BIZ(approve) | in_progress | eliciting: catches injection/distress evasions the floor misses; SUP-06 money-safe |
| Promote `OUTGOING_OFFER_CHECK` (money guard) | BIZ(approve) | in_progress | additive over the always-on floor |
| pgvector-HNSW ANN adapter (replace brute-force scan) | BUILD | in_progress | scale, not launch — `docs/adr/0020...md D3` |
| `catalog-index` scheduler (Cloud Run Job/cron) | INFRA | in_progress | today CLI-only — `jobs/catalog-index.ts` |

Each promotion is: eval ✅ → shadow ✅ (done) → **canary on the pilot merchant** → your approval. The pilot IS
the canary population.

## Phase 3 — broaden (post-first-merchant)

| Item | Owner | Status | Note |
|------|-------|--------|------|
| Live commerce adapter (orders/refunds/subscriptions) | BUILD | pending — `model.ts:60-70` | unblocks real support/commerce actions |
| Shopify Billing API + pricing model | BUILD+BIZ | pending — none in `packages/` | to charge merchants (vs manual invoicing) |
| Shopper identity: App Proxy (0017) / CAA OAuth (0018) / guest (0019) | BUILD(built)+INFRA | in_progress | per-shop provisioning + security re-review — `server.ts:696,794,1111` |
| GDPR: `customers/data_request` export + full erasure | BUILD+LEGAL | pending — `shopify-webhooks.ts:670-728` | required before an EU merchant |
| Cross-visit memory go-live | BIZ/LEGAL | in_progress (inert) | `MEMORY_ADR_ACCEPTED` false + §A legal gate all OPEN — `widget-memory/src/flag.ts:12` |
| Merchant/admin consoles | BUILD | pending | operator CLI is the only config path today — `CLAUDE.md §6` |
| Multi-merchant self-serve onboarding (beyond manual) | BUILD | in_progress — `merchant-store.ts:54-78` | scale beyond hand-provisioned pilots |

## Track S — self-improve to production (parallel; NOT on the launch critical path)

The full propose→gate→shadow→canary→approve→promote→monitor pipeline is built, tested, fail-closed, and
governance-correct — but runs only as a library/CLI/local capability. To make it *operable* in production:

| Item | Owner | Status | Note |
|------|-------|--------|------|
| **Deploy the control-plane as its own service** | INFRA | in_progress — `control-plane/src/server.ts:443` (binds 127.0.0.1; Dockerfile CMD `pnpm backend`) | **the single biggest self-improve blocker** — every approve/promote/monitor/Approval-Center surface is unreachable |
| Live-quality measurement (real signal, not operator-attested) | BUILD | pending — `champion-promoter.ts:216-251` | monitor/rollback react to a reported signal today |
| Verify the cross-family (Claude) gating judge live | INFRA(keys)+BUILD | in_progress — `judge/src/anthropic-api.ts:3` | UNVERIFIED-LIVE; CI dormant |
| Wire the eval/shadow gates into CI (currently manual) | BUILD | in_progress — `.github/workflows/eval-quality.yml` | so gates run automatically |
| ADR-0014 auto-optimize enablement | BIZ/LEGAL | pending — ADR still Proposed, reviewers BLOCK, baseline ~0.55 < floor | keep dormant until the quality baseline clears the floor |

Governance guardrail (all phases): prod is human-promoted; the control-plane deploy and any auto-optimize
enablement are governance-touching (§3) and stay human-owned. Nothing here auto-ships to shoppers.

---

## Critical bottleneck + recommended first move

**The launch critical path bottleneck is the storefront-embed chain (Phase 1, #1→2→3→4)** — it is the only
thing that gets the agent onto a real store, and it is mostly [BUILD] gated by one [INFRA] step (registering
the app). The self-improve control-plane deploy is high-value but *parallel* — it does not gate a first
merchant launch.

**Recommended first work item:** the **embeddable widget (Phase 1 #4)** — it is pure [BUILD], has no
dependency except the app registration decision, converts the existing demo page into a real `w.js` loader +
snippet, and is the visible proof a merchant can mount the agent. Design it first (embed mechanism: iframe vs
shadow-DOM inline script; the embed-key flow), then build test-first. **Status update (2026-08-10): code
done on `feat/embeddable-widget` (unmerged)** — see Phase 1 #4 above; once merged, only the [INFRA] step
(`shopify app deploy` + hand-setting the real host) remains.

Sequence to a pilot: **decide pilot scope (5) → register the app (1, human) → build the install/token chain
(2,3) + the embed (4) in parallel → stand up prod (5,6) → soft-launch to the design partner → the pilot
becomes the canary for Phase-2 promotions.**
