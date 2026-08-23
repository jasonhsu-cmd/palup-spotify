# ADR-0022: Per-shop offline Admin token for catalog sync (supersedes ADR-0020 D1)

- **Status:** **Proposed** — 2026-08-23 (owner: jason.hsu). **Governance-touching** (adds a persisted
  credential across every merchant store; reverses a prior ADR): merges only on a named-human owner
  after a **`security-reviewer`** pass on token custody and **owner sign-off**. Until then, nothing in
  this ADR ships. Load-bearing Shopify world-facts were fact-checked against primary sources on
  **shopify.dev 2026-08-23** (see the catalog-sync design spec, Appendix A); assistant knowledge
  cutoff is Jan 2026, so post-cutoff facts rest on live fetch, not memory.
- **Security review:** **PASS-WITH-CONDITIONS** (`security-reviewer`, 2026-08-23). One critical
  finding (F1, uninstall-trigger) is resolved in the Decision text below; the full condition set the
  implementation must meet is in **§ Security-review conditions**. Owner sign-off still required to
  move to Accepted.
- **Supersedes:** **ADR-0020 D1** (Shopify API scope + webhook custody) — the token-custody clause
  only. The rest of ADR-0020 (D2/D5 freshness + staleness ceiling, the read-only scope set, the
  declarative-webhook mechanism, the boolean-only `availableForSale` contract) **stands unchanged**.
- **Context:** ADR-0020 D1 chose to keep catalog reads on the **Storefront delegate token** and to
  hold **no persisted offline Admin token** — subscribing webhooks declaratively via
  `shopify.app.toml` — explicitly for **lowest blast radius** on a single/dev store. That was correct
  for that world. The product's committed end-state is a **Shopify public app** on the App Store,
  installed on **millions of merchant stores** via OAuth, serving hundreds of millions of shoppers,
  with catalogs up to the ~50,000-SKU design ceiling (ADR-0020 D5). At that scale D1's minimization
  breaks three ways, all verified on shopify.dev 2026-08-23:
  1. A public app **already receives a per-shop offline Admin access token at install** (the default
     token; persists across sessions; intended for background/scheduled jobs). The token is not an
     add-on we can decline — it is the standard public-app artifact.
  2. **Fleet backfill needs Bulk Operations, which is Admin-GraphQL-only.** The Storefront API has
     **no** bulk export; paging it to load millions of large catalogs is the operational bottleneck
     Bulk Operations exists to remove.
  3. **Fleet-scale freshness needs periodic full reconcile** (missed webhooks are inevitable across
     millions of stores), which also needs Bulk Operations → the Admin token.
  This ADR governs persisting and using that token safely. It is a prerequisite of the durable
  catalog-sync design (`docs/superpowers/specs/2026-08-23-durable-catalog-sync-design.md`).

## Decision

**D1′ (supersedes ADR-0020 D1).** PalUp **persists a per-shop offline Admin access token** and uses
it as a **sync-plane-only** credential — never on the shopper hot path. Governed as follows:

- **Least privilege.** Read-only Admin scopes **`read_products` and `read_inventory`** only — no
  write, order, or customer scope (unchanged from ADR-0020 D1). Holding `read_inventory` does **not**
  authorize surfacing stock counts; the boolean-only `availableForSale` contract stays (ADR-0020
  §8a). Production requests exactly this set; the broader staging scope set
  (`write_customers`/`write_orders`, for test-shopper seeding) is a **staging-dev-app-only**
  authorization and must not reach the production app (existing scope-pinning test).
- **Custody via the `CryptoPort`-backed `MerchantCredentialStore`** (the existing hardened per-tenant
  credential pattern — AES-256-GCM envelope, per-tenant HKDF-derived key mixing `tenantId`, GCM AAD
  binding `collection|tenant|record`, atomic audited write), **not** the read-only `SecretsPort`
  (which has no `put` and cannot store a programmatically-minted token). The Admin token uses a
  **distinct record key** (e.g. `admin_offline`) and a **distinct key scope** from the storefront
  delegate token, so compromise or rotation of the delegate key never exposes the higher-privilege
  Admin token. **Production requires a KMS-backed `CryptoPort` adapter** (the current adapter derives
  key material locally). Stored **encrypted, per tenant**, never in code, prompts, or logs; only the
  custody module holds it; no SQL or catalog-shape code touches it. (ADR-0001, CLAUDE.md §5.)
- **Refresh.** Under managed install / token exchange the offline token is a **refreshable expiring**
  token; the custody module owns refresh so background sync keeps working. Persist non-secret
  `expiresAt` metadata to refresh proactively; refresh is **single-flight per tenant** (no stampede)
  and **audited** (a distinct `token.refresh` action, never a silent in-place update). (Exact refresh
  mechanics to be confirmed on shopify.dev at implementation — spec §13.)
- **Revoke — two-step, matching the trust of each signal (resolves F1).**
  `app/uninstalled` carries its shop in an **unsigned header** (the HMAC covers the body only, which
  may report `myshopify_domain: null`), so it must trigger **only reversible** actions — halt the
  tenant's sync + `setStatus(uninstalled)` + tombstone — exactly as the existing bounded-header-trust
  design does (`shopify-webhook-identity.ts`). The **irreversible** step — hard-delete the stored
  token + retire the catalog — runs only on **`shop/redact`**, whose `shop_domain` **is** HMAC-covered
  and which Shopify sends 48h post-uninstall. This prevents a replayed `app/uninstalled` with a
  spoofed shop header from destroying an arbitrary tenant's token/catalog.
- **Kill switch + audit.** The sync plane runs under the existing enablement registry + kill switch;
  disabling a tenant halts sync, and serving falls back to last-known-good **local** data (never a
  live shopper-path Shopify call). Every token mint/refresh/revoke and every backfill/delta action
  logs to the immutable audit log (actor, input, decision, reversal). (CLAUDE.md §3.4–3.5.)
- **Serving uses no Shopify credential.** With the local `catalog_product` store, shopper serving
  reads local Postgres only; the **Storefront delegate token's hot-path role disappears** and it
  becomes optional/legacy. The Admin token is background-only.

**Retained from ADR-0020 D1 (not changed by this ADR):** declarative webhook subscription via
`shopify.app.toml [[webhooks.subscriptions]]` (Shopify auto-subscribes each shop at install; the
scalable registration path); the `read_products`/`read_inventory` scope set; API-version pinning; and
the `availableForSale` boolean contract.

## Alternatives considered

- **A — Keep ADR-0020 D1 as-is (Storefront-only, no Admin token).** Backfill by paging the Storefront
  API through a rate-limited client. *Rejected:* no bulk export → fleet backfill of millions of large
  catalogs is prohibitively request-heavy and slow; no full-reconcile path to repair missed webhooks;
  and some render fields (e.g. `status` draft/archived, certain metafields) are Admin-only. The
  minimization saves a credential PalUp's public app already holds anyway.
- **B — Transient Admin token (mint at install, backfill, discard).** *Rejected:* periodic full
  reconcile needs the token again; a discard-then-re-OAuth loop is more moving parts and more failure
  modes than governed persistence, for no real reduction in blast radius (least-priv + revoke-on-
  uninstall already bound it).
- **C — Persist a per-shop offline Admin token, least-priv, encrypted, refresh + revoke (chosen).**
  Matches the actual public-app model, unlocks Bulk Operations + reconcile, and bounds blast radius by
  least privilege, encrypted custody, kill switch, and revoke-on-uninstall.

## Consequences

- **A `security-reviewer` pass is mandatory before ship** — on token storage, rotation, revocation,
  blast radius, and kill-switch coverage. This ADR does not authorize implementation on its own.
- **Blast radius (production scope set)** of a leaked token is bounded to read-only product/inventory
  data for one shop, revocable (uninstall/`shop/redact`, secret rotation, kill switch), carrying no
  money, order, customer, or write capability. **Staging caveat (F3):** the staging dev app currently
  holds `write_customers`/`write_orders` (for test-shopper seeding) — a **staging** token is therefore
  write-capable on customers/orders, so the "no write capability" bound applies to **production only**.
  These write scopes must be hard-excluded from the production default and `shopify.app.toml`
  (extended scope-pinning test), and staging credential custody must be isolated (separate key
  material + DB) so a staging token/key compromise cannot touch production.
- **Increased at-rest data sensitivity (F8, honest note).** Reversing D1's minimization means the
  Admin read token (and the local store it fills) exposes more than the Storefront delegate token did:
  `status` reveals **draft/archived** (unreleased) products, and raw stock is available. Data
  minimization applies: the store persists only the `availableForSale` **boolean** the surfacing
  contract permits — **not** raw `inventoryQty` — and filters draft/archived at ingest unless a
  concrete serving consumer needs them.
- **Compliance-webhook dependency.** Shipping the public app requires the App-Store-mandatory
  compliance webhooks (`customers/data_request`, `customers/redact`, `shop/redact`); `shop/redact`
  interacts with catalog+token erasure. Their legal/erasure semantics are owner/legal-gated and
  deferred to prod (out of scope for the build), but noted here as a listing prerequisite.
- **Config reconciliation.** Managed install + token exchange (embedded app) is the correct public-app
  posture — this resolves, rather than conflicts with, the staging app's `embedded=true` /
  `use_legacy_install_flow=false` config; the earlier legacy-delegate-token assumption in code is the
  path being superseded.
- **Staging = increment 1.** The staging dev app exercises this exact path with a single tenant and
  its own offline token — not a different architecture. Production (and this ADR moving to Accepted)
  is a later human step.
- **Downstream:** unblocks the durable catalog-sync design's Sync plane (Bulk Operations backfill +
  periodic reconcile). No change to the retrieval/ranking model or to any HITL money/model/business
  boundary (§3.1).

## Security-review conditions (must hold in the implementation)

From the `security-reviewer` pass (2026-08-23, PASS-WITH-CONDITIONS). Each is a merge-gate condition
on the code that implements this ADR; writing-plans must carry them as acceptance criteria.

1. **(F1 — resolved in Decision)** `app/uninstalled` (header-sourced) → reversible halt +
   `setStatus(uninstalled)` + tombstone only; irreversible token hard-delete + catalog retire → only
   on HMAC-covered `shop/redact`.
2. **(F2)** Custody via `CryptoPort`-backed `MerchantCredentialStore` with a distinct record key + key
   scope for the Admin token; production requires a KMS-backed `CryptoPort` adapter. Not the
   `SecretsPort`.
3. **(F3)** Scope-pinning test hard-excludes all write scopes from the production default +
   `shopify.app.toml`; blast-radius claim bounded to the production scope set; staging write-capability
   isolated (separate key material + DB) or minimized.
4. **(F4 — SSRF/egress)** The new `shopify-client.ts` host-allowlists the Admin GraphQL endpoint
   (byte-identical to the Storefront `SHOP_HOST` allowlist), https-+host-allowlists the Bulk-Operation
   result `url`, **never** attaches the Admin token to the (pre-signed) result download, and never logs
   the token.
5. **(F5 — kill switch, NN#4)** Backfill/reconcile re-check the kill switch/enablement **and** token
   presence between steps (per page / per poll) and abort promptly; a **sync-plane-scoped** kill exists
   (distinct from the serving kill), and serving stays on last-known-good local data.
6. **(F6)** Persist `expiresAt`; refresh is single-flight per tenant and audited; the no-hot-path-
   fallback rule stays structurally enforced (serving plane holds no Shopify credential).
7. **(F7 — confused deputy)** Token exchange validates the session token's shop binding and that the
   returned token binds to the same shop; client secret via the secrets port, never logged;
   client-secret rotation coordinated with webhook HMAC verification (Shopify's ≤1h propagation).
8. **(F8)** Persist the `availableForSale` boolean, not raw `inventoryQty`; filter draft/archived at
   ingest unless a concrete consumer needs them. (Also reflected in the Decision + Consequences.)
9. **(F9)** Production uses a separate DB + separate key material from staging; the PalUp-side
   tenant-deletion path also deletes the token; multi-region/residency and backup-key-destruction are
   called out as prod-gate items.
10. **Audit completeness (NN#5)** confirmed for mint / refresh / revoke / backfill (incl. the >50k
    truncation log) / delta — no silent path.

## Open items to confirm at implementation (not from memory)

1. Managed-install token-exchange **refresh** mechanics (endpoint, expiry window, refresh trigger).
2. `bulkOperationRunQuery` lifecycle details (poll fields, result-`url` expiry, partial results).
3. Re-confirm the per-topic webhook→scope strings for the pinned API version (ADR-0020 D1 verified
   them 2026-08-07).
