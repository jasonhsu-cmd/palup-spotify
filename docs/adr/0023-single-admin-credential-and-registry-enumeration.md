# ADR-0023: Single Admin credential for the catalog lifecycle + governed registry enumeration

- **Status:** **Proposed** — 2026-08-24 (owner: jason.hsu). **Governance-touching** (retires a prior least-privilege posture; adds a deliberately-withheld enumeration surface): merges only on a named-human owner after a **`security-reviewer`** pass and **owner sign-off**. Until then, Phase 2 of the implementation plan (the cutover) does not ship. Shopify world-facts verified on shopify.dev **2026-08-24** (see the credential-enrollment-unification spec §10.1).
- **Supersedes / amends:** the credential half of **ADR-0022 D1′** and the residual delegate role in **ADR-0020 D1** — the Storefront **delegate** token is retired; the DB-custodied **Admin offline token** becomes the **sole** Shopify credential for the whole catalog lifecycle (sync + serving). ADR-0022's Admin-token custody, F1 two-step revoke, F2 distinct key scope, kill switch, and audit are **retained and extended**.
- **Context:** The credential-and-enrollment-unification design (`docs/superpowers/specs/2026-08-24-credential-enrollment-unification-design.md`, decisions B + i + i) converges catalog sync onto one ingestion pipeline reading one credential, with serving fully local, at millions-of-merchants scale. Two governance changes fall out of that and are recorded here.

## Decisions

**D1 — The Admin offline token is the SOLE Shopify credential for the catalog lifecycle.** The Storefront **delegate** token (`unauthenticated_read_product_listings`) is retired for sync AND serving. Every consumer (serving, ingestion, reconcile, retention) reads the one DB-custodied Admin token (read-only `read_products`/`read_inventory`, ADR-0022 F2 scope/custody). Serving becomes 100% local (`catalog_product` + `product_facts` + pgvector + `store_profile`); brand/policy move off the Storefront `getShell` onto the local `store_profile`.
- *Refresh lifecycle (verified spike, spec §10.1).* For a public app the offline token is the **expiring** variant (`expires_in=3600`) with a **`refresh_token`** (`refresh_token_expires_in`=90d), refreshable **server-side without a user** ("background jobs and webhooks"). The design therefore stores the `refresh_token` + expiries, runs a mandatory single-flight audited refresh loop, and on a lapsed `refresh_token`/`401` **halts sync + raises a re-auth signal** (never a hot-path fetch). Non-expiring offline tokens are being retired for public apps by **Jan 2027**, so no static-token dependence.
- *Rationale.* One credential, one custody/refresh/revoke lifecycle, no Storefront-vs-Admin split, no `PALUP_SECRETS`-per-tenant token map to desync on reinstall (the concrete failure this fixes: a stale env Storefront token 403'd the target store this session). Privilege is unchanged in kind (both were read-only); the concentration onto one token is bounded by ADR-0022's least-privilege scope + encrypted custody + revoke-on-uninstall + kill switch.

**D2 — Governed registry enumeration (`listActive`).** `MerchantRegistryPort` gains `listActive({cursor,limit}) → {items:{tenantId,shopDomain,status}[], nextCursor}`: cursor-paginated (keyset), **active-only**, **secret-free** (only the existing non-secret allowlist columns — never a token), one audited call per page. Jobs enumerate the fleet from this (retiring hand-maintained `SHOPIFY_STORES` lists), so enrollment (install writes a row) and enumeration (jobs read rows) share one source and cannot drift.
- *Rationale.* The registry deliberately offered no cross-tenant scan (data-safety). That concern was about **ad-hoc cross-tenant data reads**; a paginated, secret-free, audited fleet enumeration for the scheduler is a different, legitimate, bounded operation — and the only way to reach millions of merchants with zero per-merchant ops.

## Alternatives considered
- **Keep the Storefront delegate for the read-only serving/shell role (design option ii).** Two credentials, both DB-custodied. *Rejected by the owner (decision i):* avoids depending on the Admin refresh loop for serving but keeps two credential lifecycles + the delegate mint. The spike confirmed the Admin refresh path is viable, removing the main reason to keep the delegate.
- **A separate "sync roster" table for enumeration.** *Rejected:* two merchant lists that drift — the exact desync class being eliminated.

## Consequences
- **Hard dependency:** the Admin-token refresh lifecycle (refresh_token storage + server-side refresh loop) must be live before the cutover — plan Task 6 (gated on this ADR + the spike). If the refresh loop fails, serving degrades to last-known-good local data (no live fallback exists by design), and sync halts with a re-auth signal.
- **Blast radius (unchanged in kind):** a leaked Admin token is read-only product/inventory for one shop, revocable (uninstall/`shop/redact`, rotation, kill switch). Now the *sole* catalog credential, so its custody + refresh correctness is load-bearing — hence the `security-reviewer` gate.
- **Enumeration:** `listActive` is the one fleet source; a page failure is retried, never fatal to the run; no unbounded scan.
- **Migration/rollback:** the cutover ships behind one `CATALOG_UNIFIED` flag with the old Storefront code kept dormant one release (spec §9). Production is a separate §5 human promotion (separate DB + KMS-backed CryptoPort, ADR-0022 F9).
- **Retained from ADR-0022:** two-step revoke (F1), distinct admin key scope (F2), least-priv read scopes (F3), SSRF host allowlist (F4), sync-plane kill (F5), audit (NN#5).

## Security-review conditions
(To be filled by the `security-reviewer` pass — Task 0b Step 2 — before this moves to Accepted.)

## Open items
1. Live dev-store confirmation of the refresh_token grant (deferred to staging-enable; docs verified 2026-08-24).
2. Whether Admin Bulk/GraphQL supplies brand + policies for `store_profile` (spec §10.2) — else a one-shot Admin `shop`/`shopPolicies` query.
