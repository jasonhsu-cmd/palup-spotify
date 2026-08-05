# ADR-0012: Per-merchant grounding from Shopify, behind the grounding port

- **Status:** Accepted — implemented (M2). Live on staging for one tenant (`demo` → a real Shopify dev
  store); the Storefront API surface + fields were verified against **v2026-07** and the live fetch is
  security-reviewed. Remaining: production multi-merchant onboarding (connect-store OAuth + per-tenant
  enable + the `WIDGET_AUTH_REQUIRED` flip). See Consequences.
- **Context:** The shopper widget's value is that it recommends the **merchant's own** products and
  answers with the **merchant's own** policies — never inventing SKUs or prices. Through M1 the agent's
  state/audit/kill/rate-limit/tenancy were made tenant-isolated, but its **grounding** (catalog +
  policy) was a single hardcoded demo catalog (the "Auria" fixture) served to every tenant. The M1
  slice-3 security review flagged this as the last cross-tenant surface: once a second real merchant is
  onboarded, un-tenanted grounding is a correctness *and* data-leak risk. M2 makes grounding
  per-merchant and sourced from the merchant's real store, without coupling feature code to Shopify and
  without letting a slow/broken/unauthorized store hang or degrade the widget. The `GroundingPort`
  already exists (`getContext(tenantId) → {tenantId, brandName, products[], policy}`) with a contract
  suite; ADR-0001 already names a `secrets` port; ADR-0011 defines how a merchant authenticates and
  authorizes PalUp to read their store.

## Decision

1. **Grounding source = Shopify Storefront API, behind `GroundingPort`.** The merchant's catalog
   (products → `{id,title,description,price,tags}`) and policy (returns/shipping) come from Shopify's
   **Storefront API** (buyer-facing, published data, correct localized prices) via a per-shop
   **Storefront access token**. The Storefront surface is chosen over the Admin API for
   **least-privilege** (NN#6): it exposes only published storefront data, not inventory/cost/customer
   PII. All Shopify/GraphQL types stay **inside the adapter**; only `GroundingContext` crosses the port
   (NN#3 / ADR-0001). A second commerce platform is a new adapter, not a rewrite.

2. **The request tenant drives grounding, server-derived.** The verified widget-token tenant
   (`Signals.tenantId`, set only by the server — never client input) is threaded end-to-end into
   `getContext(tenantId)` and the model tenancy tag. The per-policy-cached brain stays tenant-agnostic;
   tenant rides each request. (Shipped in M2 slice 1.)

3. **Per-merchant credentials via the `secrets` port.** Tenant→store resolution splits into a
   **non-secret** shop domain (a JSON registry, safe in config) and the **secret** Storefront token
   (via `SecretsPort`, realizing ADR-0001's named port — env/in-memory adapter now, a cloud
   secret-manager adapter later). A tenant is "Shopify-configured" only when **both** resolve;
   otherwise the composition root falls back to fixtures. Tokens never live in code, prompts, or logs.
   (Shipped in M2 slice 2.)

4. **Caching + degrade-never-hang, as a port decorator.** `createCachingGroundingPort` caches each
   tenant's context on the `RuntimeStatePort` (tenant-isolated by construction), fresh for a TTL
   (default 30m, catalog changes rarely); **hard-timeouts** the upstream so it can never hang `/chat`;
   serves **stale-while-error** (last-known-good) on a transient failure; and **fails closed to a
   safe-empty context** on a cold failure or a revoked token — the brain then honestly says it can't
   find products rather than inventing them or leaking another tenant's catalog. (Shipped in M2
   slice 3.)

5. **Fixtures-first delivery.** The composition root picks the Shopify adapter when a tenant's Shopify
   credential resolves (via `SecretsPort`), else a multi-tenant **fixtures** adapter (mirrors
   `isVertexConfigured()` for the model port). Grounding therefore ships and is fully
   contract/isolation/degradation-tested **before** any live Shopify credential exists; live serving is
   flipped on per-merchant by a human when the store connects.

## Alternatives considered

- **Admin API instead of Storefront API.** Richer (inventory, cost, unpublished data). Rejected as the
  grounding source — it violates least-privilege for what grounding needs (published catalog + policy)
  and widens the blast radius of a leaked token. (A narrowly-scoped Admin/metafield read may be added
  later only for fields Storefront lacks — see the allergen gap below.)
- **Storefront / Catalog "MCP" surface.** Possibly the more agent-native surface; **not verified**
  against current Shopify docs as of this ADR (author knowledge is pre-cutoff). Left as a candidate the
  adapter can adopt behind the same port without a feature-code change.
- **Fetch grounding live on every `/chat` (no cache).** Simplest. Rejected — adds Shopify latency and a
  hard dependency to every shopper turn, and a Shopify outage would break the widget. The caching
  decorator removes both.
- **Bake tenant into the brain at construction.** Rejected — brains are cached per policy and shared
  across tenants; baking a tenant in would cross-contaminate. Tenant is per-request.

## Consequences

- (+) The agent grounds on each merchant's real catalog/policy, tenant-isolated, portable behind the
  port; a second commerce platform or a cloud secret manager is a new adapter.
- (+) Resilient: a slow/down/unauthorized store degrades gracefully (stale or safe-empty), never hangs
  the widget; least-privilege token scope limits blast radius.
- (+) Shippable and testable now (fixtures-first); live serving is human-gated per merchant.
- (resolved) The live Shopify API surface + fields were verified against the **Storefront API v2026-07**
  docs (retrieved 2026-07-30) and the live fetch is implemented + running on staging against a real dev
  store (private token via the SecretsPort; `*.myshopify.com` host guard; degrade-never-hang). The
  query/fields should be re-verified when Shopify bumps the API version.
- (resolved) **Catalogs larger than one page are now fetched whole, and one too large to serve fails
  loudly.** The adapter follows `pageInfo.endCursor` into the connection's `after` argument (fields
  verified against the v2026-07 docs, retrieved 2026-08-05) up to a hard ceiling of **4 pages × 250 =
  1000 published products**, and returns **only a complete catalog**: crossing the ceiling, losing a
  later page, or getting an unusable/non-advancing cursor all **throw** (with a `reason` on the
  structured egress log) so the caching decorator degrades to last-known-good/safe-empty. Truncating was
  rejected because the brain's prompt ("recommend ONLY from the CATALOG", "never invent products") turns
  a missing product into the agent *denying* the merchant carries it — a confident false claim to a
  shopper that looks healthy to every monitor — and because a partial catalog would be cached as
  last-known-good for the whole TTL. Above 1000 SKUs the answer is relevance retrieval (fetch → index →
  top-K), not a bigger prompt: `composeSystemPrompt` renders every product on every turn. Pagination is
  fixture-tested against an injected fetch; it has **not** been exercised against a live store.
- (−) **Allergen has no native Shopify field** (recollection, verify) — sourced from a product metafield
  or a merchant-authored PalUp field, else omitted (`StorePolicy.allergens` is optional). A product
  decision.
- (−) Needs a human before live multi-merchant serving (§7): a Shopify dev/partner store + Storefront
  token, confirmation of the API surface/schema, the per-merchant "connect your store" OAuth flow with
  minimal scopes (ADR-0011 token exchange), and flipping `WIDGET_AUTH_REQUIRED=true` to retire the demo
  fallback before a second real tenant.
- (−) A cache TTL trades freshness for latency/resilience; webhook-driven invalidation (Shopify
  `products/update` → drop the cache row) is a later refinement, not M2.
