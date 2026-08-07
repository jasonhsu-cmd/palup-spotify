# ADR-0020: Durable grounding at scale — Workstream A foundations (A0)

- **Status:** Accepted — 2026-08-07 (owner: jason.hsu). Decisions only; A1–A4 are the implementation
  work and each ships behind the standing gates (test-first → merge-gate → for run-time-agent behaviour,
  the eval gate → shadow → canary → human promotion). The load-bearing world-facts below were
  fact-checked against primary sources on **2026-08-07** (shopify.dev, pgvector README, ai.google.dev /
  Vertex docs) — all confirmed. **Re-confirm-later:** two facts post-date the Jan-2026 knowledge cutoff
  and were verified only by live fetch — the Shopify stable API version `2026-07` (Shopify rotates
  quarterly; `2026-10` lands 2026-10-01) and `gemini-embedding-2` GA-on-Vertex; the Vertex model page is
  JS-rendered, so its 3072-default was corroborated via ai.google.dev rather than a clean Vertex quote.
- **Context:** The shopper agent fetches each merchant's *whole* catalog into the prompt every turn,
  hard-capped at 1000 products (`shopify-grounding.ts`), backed by a brute-force 5000-row vector scan
  (`postgres-vector-store.ts`, not ANN), a 30-min TTL cache, and no catalog/inventory webhooks or queue
  port. That cannot serve the target scale (millions of merchants; catalogs from a handful to thousands).
  A0 fixes the load-bearing foundations the rest of Workstream A builds on. Portability (ADR-0001) is a
  hard constraint. These decisions **extend** ADR-0004/0006/0009/0012 (which each anticipated this) and
  the `capacity-model.md` envelope; they do not overturn them.

## Decisions

### D1 — Shopify API scope + webhook custody
Keep catalog/policy **reads on the Storefront delegate token** (`unauthenticated_read_product_listings`,
unchanged). Add **only** the minimal Admin **read** scopes the ingestion webhooks require — `read_products`
(`products/create|update|delete`) and `read_inventory` (`inventory_levels/update`) — and no write, order,
or customer scopes. Holding `read_inventory` does **not** authorize surfacing stock counts: the boolean-only
`availableForSale` contract stays (§8a inv 11). Subscribe to webhooks **declaratively via
`shopify.app.toml` `[[webhooks.subscriptions]]`** (Shopify auto-subscribes on install; no persisted offline
Admin token → lowest blast radius), pinned to API version **`2026-07`**. *Rationale:* webhooks are an
Admin-API/app-config mechanism (not available on the Storefront surface), so the split is the least
privilege that meets the requirement; it matches the narrow-Admin-read extension ADR-0012 anticipated.
*Verified (shopify.dev, 2026-08-07):* the two topic→scope mappings and the `2026-07` stable version.

### D2 / D5 — Freshness SLA + scale envelope
Price/availability freshness target **≤15 min on the poll path**, near-real-time on the webhook path; past
a **hard staleness ceiling the agent says "let me confirm current price/availability" rather than quoting a
stale number** (fail-honest; a quoted price is a money/NN#1 fact). Per-catalog **design ceiling ~50,000
SKUs** (today's 1000 is a cap to escape, not a target). Fleet envelope = the `capacity-model.md` numbers,
to be reconfirmed against real telemetry (today's baseline is from console mockups) as a go/no-go.

### D3 — Embedding model + ANN engine
ANN = **pgvector HNSW** behind the existing `vector` port (new adapter in `state-postgres`; the brute-force
adapter stays as the small-corpus/exact fallback). Embedding model = **`gemini-embedding-2`** (GA on Vertex;
model id `gemini-embedding-2`), **Matryoshka-truncated to 1536 dims**, indexed as the native **`vector(1536)`**
HNSW (1536 ≤ pgvector's 2000-dim `vector` index cap, so no `halfvec` is needed; `halfvec(1536)` is available
if we later want to halve index RAM further). *Rationale:* 1536 is a Google-recommended Matryoshka tier
(3072/1536/768), so expected recall loss is small while roughly halving index RAM/COGS versus 3072 — the
binding cost at 10⁹–10¹⁰ vectors is HNSW RAM, not disk. pgvector keeps runtime state + memory + catalog in
one engine and one transactional DELETE for erasure (ADR-0015), versus a managed vector DB's second datastore
and cross-store erasure problem. *Fallback:* if the eval gate shows degraded retrieval at 1536, go to 3072
(`halfvec`). *Verified (2026-08-07):* pgvector `vector` HNSW cap 2000 / `halfvec` 4000 (≥0.7.0);
`gemini-embedding-2` GA on Vertex with `output_dimensionality` 128–3072 (1536 supported).
**Non-waivable (§3.2 / HITL §5):** this is the model-*selection* decision only — enabling `CATALOG_RETRIEVAL`
with this embedding to serve shoppers still passes the standing eval gate → shadow → canary → human
promotion. Re-confirm the 3072-default and the exact task-type params from the Vertex model page before A2
pins the corpus manifest `{model, dimension}`.

### D4 — Queue port + worker runtime
Build the `QueuePort` ADR-0006 already names (enqueue/schedule + publish/subscribe, tenant-scoped ctx, a
neutral envelope, an in-memory reference adapter + a shared contract test — the RuntimeStatePort pattern).
Default adapters: **Cloud Tasks** for enqueue/schedule, **Pub/Sub** for fan-out. Webhook ingestion verifies
HMAC in-request → enqueues → returns 200; a **push-to-Cloud-Run worker** reconciles by re-fetching current
product state (never trusting the payload — out-of-order-safe) through the existing `runCatalogIndex` path;
the scheduled catalog-index job stays as the **missed-event backstop** (Shopify delivery is at-least-once).
A0 scope = enqueue + consume + idempotency; publish-fan-out is deferred to the agent-runtime lane (ADR-0005).
*Rationale:* enqueue-then-200 is the standard webhook-safety pattern and fixes today's synchronous coupling;
provider SDKs stay inside the port adapters (ADR-0001).

### C1b — Cart permalink locus (recorded here as it rode A0)
The Shopify cart permalink is built **widget-side**: the neutral layers carry only an opaque `variantId`;
the widget (which runs on the merchant's store and knows its domain) builds `/cart/{variantId}:{qty}`
client-side. No Shopify-shaped URL enters the vendor-neutral backend/brain — the portable placement.

## Consequences
A1 (Tier-2 `ProductFactsPort` + hydrate-by-ID serving), A2 (pgvector-HNSW adapter + the
`gemini-embedding-2`@1536 wiring), A3 (`shopify.app.toml` webhooks + `QueuePort` + reconciliation), and A4
(progressive `CATALOG_RETRIEVAL` enablement, through the eval gate + human promotion) are buildable against
these decisions. Everything stays behind ports, so a second commerce platform remains an adapter, not a
rewrite (NN#3). Poll-first (D2) delivers the freshness win with zero new webhook/queue infra; webhooks are a
drop-in producer against the same Tier-2 store once the queue port lands. The two re-confirm-later facts in
the Status block must be re-checked if this ADR is read after the next Shopify version rotation.

## Refinement decisions (2026-08-08, owner: jason.hsu)
Follow-on decisions taken while sequencing the A/B/C build; they refine (and in one case reverse) the above.

- **A2 test-infra:** the pgvector-HNSW adapter is verified against a **real Postgres+pgvector in CI**
  (Dockerized/testcontainer in the merge-gate), not pglite (which lacks the `vector` extension). This is a
  CI-infra prerequisite for A2; the ANN adapter's contract runs against real pgvector, so HNSW recall/DDL
  is genuinely exercised, not mocked.
- **Progress record #185 REVERSAL — C1 cart link:** decision #185 made the widget's product cards
  deliberately NOT links/CTAs because the system had "no cart or checkout capability" (guarded by
  `widget-backend/test/shopper-promise-guard.ts`). C1 makes a Shopify cart permalink a **real** capability,
  so the premise no longer holds. DECIDED: wire a **low-key "view in cart" link** (a real, working `/cart/`
  deep link) — understated, NOT an aggressive "Buy now" CTA, preserving #185's anti-false-promise *spirit*
  while enabling one-tap conversion. The shopper-promise guard is updated to reflect the now-real
  capability (the guard's own rule: "wire the capability or reword the text" — here we wire it).
- **Non-English corpora:** the es/zh-Hant guard-detection cases + crisis-string translations are **drafted
  by the build agent as candidates, then vetted by a native reviewer before they GATE** (a machine draft is
  never trusted as the eval oracle). This unblocks building the broad classifier + phase-4 against candidate
  fixtures now; non-English *promotion* still waits on the native vet.
- **Governed PR flow:** the remaining money/safety/serving-path increments (broaden, 3b, A1b, B-T3) are
  built to **review-passed PRs that queue for a named-human merge** — never auto-merged (§3).
