# Path to production

> Turns the 2026-08-10 spec-vs-code audit (11-agent, 167 items, citation-verified) into ONE sequenced,
> dependency-aware roadmap. Target milestone: **a first real US-Shopify design-partner merchant serving real
> shoppers from their live storefront**, sales-first. Everything past that is Phase 2+.
>
> **Refreshed 2026-08-16** against merged `main` (HEAD `11bc5d4`): the Phase-1 widget/install/read-back chain
> (#287–#292) and the *entire* Phase-2 catalog-retrieval-at-scale stack (S1–S4, #297–#304) have since merged —
> all **dark / flag-gated**. Statuses, merge-state, and citations below were re-verified against code this pass.
>
> **Current state (one line):** the shopper-serving stack — embeddable widget, OAuth install, per-tenant
> storefront read-back, and catalog-retrieval-at-scale — is now **merged to `main` but ships dark / flag-gated**;
> there is still **no production deployment** (staging only); the **control-plane is deployed on internal staging** (`palup-control-staging`, IAM-gated) but **not in production**,
> `packages/agent-runtime` **does not exist yet** (design + ADR-0005 only), and commerce runs on fixtures.
> Enabling any of it is a human-gated config/infra step, not a single flag flip.

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
2. **[INFRA/config] Turn on install → storefront read-back in prod** — the loop is **code-complete and merged
   to `main`** (#288 `f08cf6d`, ships dark): the OAuth install custodies a per-tenant delegate token, and serving
   reads it via `resolveStorefrontCredential` (`packages/widget-brain/src/model.ts:61`) when
   `MERCHANT_CRED_READBACK_ENABLED` is set (process-global env, default **OFF** in code — `server.ts:320`). The
   staging deploy wires the flag through (`deploy-staging.yml:108`, defaulting to `false`); whether it is actually
   ON in staging is a GitHub repo var, **not repo-verifiable here**. Remaining work is **config/infra**: set the
   flag in a prod deployment so an OAuth-installed merchant grounds on THEIR catalog instead of fixtures.
3. **[BUILD-done · INFRA-remaining] The embeddable widget — merged to `main` (dark / flag-gated).**
   The theme app extension (`extensions/palup-widget/`), the loader (`packages/widget/src/loader-entry.ts`),
   and the `/embed/*` backend routes merged across #287 (`67fa7f5`), #289 hardening (`4c95814`), #291 self-serve
   custody (`178429b`), and #292 shop-specific webhooks (`b6307a8`). What remains is [INFRA]:
   `shopify app deploy` (item 1) registers the extension; separately, a human must hand-edit the
   `REPLACE_WITH_APP_HOST` placeholder in `app-embed.liquid` + `shopify.app.toml` to the real app host —
   no build-time substitution exists for it (verified: nothing in the repo's scripts, CI, or package.json
   touches that string). See `docs/DEPLOY.md` *Embedding the widget on a storefront* for the full path and
   the storefront-token caveat (a self-installed merchant still gets fixtures, not their own catalog, until
   item 2's flag is set in prod).
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
| 2 | Install→storefront-token read-back custody | BUILD→INFRA(config) | **merged (dark)** — #288 `f08cf6d`; `model.ts:61` / `server.ts:320`; remaining = set `MERCHANT_CRED_READBACK_ENABLED` in prod | 1 |
| 3 | Serve merchant's own catalog (D2 fix) | BUILD→INFRA(config) | **merged (dark)** — same read-back path (#288); on once item 2's flag is set | 2 |
| 4 | Embeddable widget (theme app extension + loader + `/embed/*` routes) | BUILD | **done — merged to `main` (dark)** — #287/#289/#291/#292; `extensions/palup-widget/`, `packages/widget-backend/src/routes/embed.ts`; live traffic still gated on 1 | 1 |
| 5 | Prod Cloud Run service + deploy workflow | INFRA | pending — `docs/DEPLOY.md:3` | — |
| 6 | `WIDGET_AUTH_REQUIRED=true` in prod | INFRA(config) | in_progress — `server.ts:285` | 5 |
| 7 | Human take-over: honest escalation copy OR a real producer | BUILD/BIZ | pending — `brain.ts:1100` | 5 |

Phase-1 exit: a design-partner merchant installs the app, the widget mounts on their storefront, and their
shoppers get grounded, guardrailed, sales-first answers on real Gemini — with support/commerce actions
honestly escalated. Manual invoicing; no memory; US-only.

**Remaining human steps for the embed (2026-08-16):** the branch has **merged to `main`** (dark), so what's
left is (a) `shopify app deploy` from a Partners account — registers the app + the `palup-widget` extension;
separately, a human must hand-edit the `REPLACE_WITH_APP_HOST` placeholder (`extensions/palup-widget/blocks/
app-embed.liquid`, `shopify.app.toml`) to the real host before that deploy is meaningful — nothing in
the repo substitutes it automatically (verified: no script, CI step, or pnpm task touches that string);
(b) standing up a production host (#5 above) so a real host value exists to set. Full detail:
`docs/DEPLOY.md` *Embedding the widget on a storefront*.

## Phase 2 — quality, freshness, scale (mostly already built, gated behind promotion)

This is the ADR-0020 catalog-retrieval-at-scale work — now **entirely merged to `main`, all dark**: S1 pgvector
engine #297 (`85e6d24`) → S2 serving-unlock #299 (`cb44919`) → S3 freshness #302 (`fe6a2c4`) → S4 safe-promotion
#303 (`b9f6450`), plus the §5 promotion runbook #304 (`11bc5d4`). What remains is the human **per-tenant**
promotion path (canary → approve) per `docs/DEPLOY.md` §5 and `docs/ADR-0020-PROMOTION-PLAN.md`.

| Item | Owner | Status | Note |
|------|-------|--------|------|
| Enable per-tenant catalog retrieval (two-gate: platform master + per-tenant opt-in, both default OFF) | BIZ(approve)+INFRA | **merged (dark)** | the global `CATALOG_RETRIEVAL` env was **RETIRED** (S4 §B); enablement is now `pnpm catalog:enable` — `catalog-retrieval-enablement.ts:31-34`, read `server.ts:2129-2133`. Needed once a catalog exceeds the 1000-SKU serving fetch (`MAX_CATALOG_PRODUCTS`=1000) |
| Enable `CATALOG_WEBHOOKS` producer (A3) + `terraform apply` (P3 alert, P4) | INFRA | in_progress | P4 route smoke-verified; env + apply are human — `server.ts:946` |
| Promote `PRODUCT_FACTS_HYDRATION` (A1b, money/NN#1) | BIZ(approve) | in_progress | inert until retrieval + a producer populate facts — `server.ts:527` |
| Promote `SERVER_GUARD_SIGNALS` (safety routing) | BIZ(approve) | in_progress | eliciting: catches injection/distress evasions the floor misses; SUP-06 money-safe |
| Promote `OUTGOING_OFFER_CHECK` (money guard) | BIZ(approve) | in_progress | additive over the always-on floor |
| pgvector-HNSW ANN adapter (replace brute-force scan) | BUILD | **merged (dark)** | S1 #297 `85e6d24`; `VECTOR_ANN` default off (`vector-factory.ts:28`). Scale, not launch — a corpus >5000 SKUs *requires* it; indexing ceiling `MAX_INDEXED_PRODUCTS`=50000 |
| `catalog-index` scheduler (Cloud Run Job + Cloud Scheduler) | INFRA | **built; deploy is the owner's** | hourly freshness backstop (S3 §E); runbook `docs/DEPLOY.md` *Scheduled catalog-index backstop* (`palup-catalog-index`) — job `jobs/catalog-index.ts` |

Each promotion is: eval ✅ → shadow ✅ (done) → **canary on the pilot merchant** → your approval. The pilot IS
the canary population.

## Phase 3 — broaden (post-first-merchant)

| Item | Owner | Status | Note |
|------|-------|--------|------|
| Live commerce adapter (orders/refunds/subscriptions) | BUILD | pending — `model.ts:60-70` | unblocks real support/commerce actions |
| Shopify Billing API + pricing model | BUILD+BIZ | pending — none in `packages/` | to charge merchants (vs manual invoicing) |
| Shopper identity: App Proxy (0017) / CAA OAuth (0018) / guest (0019) | BUILD(built)+INFRA | in_progress | per-shop provisioning + security re-review — `server.ts:696,794,1111` |
| GDPR: `customers/data_request` EXPORT (erasure now DONE) | BUILD+LEGAL | export **pending** — no export path exists anywhere in the repo (`shopify-webhooks.ts:65`); catalog corpus+ledger **erasure** on `shop/redact` + `app/uninstalled` is **DONE** (S4 §F, `95ec8fd`; owner chose DECISION A, HITL §8) | required before an EU merchant |
| Cross-visit memory go-live | BIZ/LEGAL | in_progress (inert) | `MEMORY_ADR_ACCEPTED` false + §A legal gate all OPEN — `widget-memory/src/flag.ts:12` |
| Merchant/admin consoles | BUILD | pending | operator CLI is the only config path today — `CLAUDE.md §6` |
| Multi-merchant self-serve onboarding (beyond manual) | BUILD | in_progress — `merchant-store.ts:54-78` | scale beyond hand-provisioned pilots |

## Track S — self-improve to production (parallel; NOT on the launch critical path)

The full propose→gate→shadow→canary→approve→promote→monitor pipeline is built, tested, fail-closed, and
governance-correct — but runs only as a library/CLI/local capability. There is also **no shared
`packages/agent-runtime` yet** — it does not exist (design + ADR-0005 only; `README.md:12` "design + scaffold"),
which is the foundational gap under everything in this track. To make it *operable* in production:

| Item | Owner | Status | Note |
|------|-------|--------|------|
| **Deploy the control-plane as its own service** | INFRA | **DONE on staging** — `palup-control-staging` (IAM-gated, shared `DATABASE_URL`; `Dockerfile.control-plane`, `HOST=0.0.0.0` bind at `control-plane/src/server.ts:519`); **not in production** | staging approve/promote/monitor/Approval-Center surfaces are reachable via IAM; the **production** deploy is the remaining infra step |
| Live-quality measurement (real signal, not operator-attested) | BUILD | pending — `control-plane/src/champion-promoter.ts:216-228` | monitor/rollback react to a **REPORTED/attested** signal today, not a measured one (the caller supplies `observed`) |
| Verify the cross-family (Claude) gating judge live | INFRA(keys)+BUILD | in_progress — `judge/src/anthropic-api.ts:3` | **UNVERIFIED-LIVE** until run with a key present; CI dormant |
| Wire the eval/shadow gates into CI (currently manual) | BUILD | in_progress — `.github/workflows/eval-quality.yml` | so gates run automatically |
| ADR-0014 auto-optimize enablement | BIZ/LEGAL | pending — orchestrator built+merged but **DORMANT and not deployed in production**; ADR still Proposed, reviewers BLOCK, baseline ~0.55 < floor | human-only enablement; keep dormant until the quality baseline clears the floor |

Governance guardrail (all phases): prod is human-promoted; the control-plane deploy and any auto-optimize
enablement are governance-touching (§3) and stay human-owned. Nothing here auto-ships to shoppers.

---

## Critical bottleneck + recommended first move

**The launch critical path bottleneck is the storefront-embed chain (Phase 1, #1→2→3→4)** — it is the only
thing that gets the agent onto a real store. As of 2026-08-16 the [BUILD] for #2/#3/#4 has **merged to `main`
(dark)**, so the bottleneck is now the remaining **[INFRA]/config** steps: register the app, stand up prod, and
flip the read-back flag. The self-improve control-plane deploy is high-value but *parallel* — it does not gate a
first merchant launch.

**Recommended first work item:** now that the embed + read-back are merged (dark), the first move is the
[INFRA] chain, not more [BUILD] — **register the Shopify app** (item 1, human), stand up a **prod host**
(items 5/6), and set **`MERCHANT_CRED_READBACK_ENABLED`** in prod (item 2) so a self-installed merchant grounds
on their own catalog. **Status update (2026-08-16): the embed is merged to `main` (dark)** — see Phase 1 #4
above; only the [INFRA] step (`shopify app deploy` + hand-setting the real host) and the read-back flag remain.

Sequence to a pilot (the install/token chain (2,3) and the embed (4) are now **merged, dark**): **decide pilot
scope (5) → register the app (1, human) → stand up prod (5,6) and set the read-back flag (2) → soft-launch to
the design partner → the pilot becomes the canary for Phase-2 promotions.**
