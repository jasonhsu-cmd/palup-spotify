# Storefront-Token Read-Back (D2) — Design

**Status:** approved (brainstorm 2026-08-10)
**Plane:** build-time change to run-time **serving plumbing**. No run-time agent behavior/prompt/model/memory changes. No new port, no vendor SDK.
**Goal (one sentence):** Make one OAuth-installed Shopify merchant serve their **own** catalog into `/chat` by closing the "D2" break — serving reads the delegate token that install already custodies — behind the existing ports, live-proven before it is enabled.

---

## 1. Background — the chain is built; one seam is open

An OAuth-installed merchant already flows almost end-to-end (verified this session):

- **Install** (`packages/widget-backend/src/routes/shopify-install.ts:342-464`) HMAC/state/timestamp-verifies the callback fail-closed, exchanges the code for an offline parent token, mints a **Storefront private delegate token** via `delegateAccessTokenCreate`, and **custodies it encrypted** at `deps.credentials.put(tenantId, delegate.accessToken, …)` (`shopify-install.ts:403`), then writes a registry row (`pk_` embed key, `status: active`).
- **Custody** is real: `packages/state-postgres/src/merchant-credential-store.ts` encrypts the token under a per-tenant `CryptoPort` key in the tenant-scoped `RuntimeStatePort` KV (`collection "merchant_cred"`, row `"storefront_delegate"`), audits the write, and exposes `read(tenantId): Promise<MerchantCredentialRead>`.
- **Serving** resolves the merchant's shop **domain** from the registry (D1, done) — but takes the **token** from a hand-provisioned `SecretsPort` key `shopify_storefront_token` (`merchant-store.ts:17,106`), **never** the custodied one.

**The break ("D2").** `MerchantCredentialStore.read()` has zero non-test callers; the store's own header declares it INERT "until C1 both obtains a delegate token AND reads it back from here." `resolveShopifyStore` (`merchant-store.ts:93-109`) — whose own comment says *"Reading B2 here is D2"* — returns `undefined` for a merchant with no `shopify_storefront_token` (`merchant-store.ts:107 if (!accessToken) return undefined`), and the router serves the built-in **fixture** catalog (`model.ts:49-50`: `if (creds) …adapter… else fixtures.getContext`). So **every OAuth-installed merchant's shoppers see the demo catalog, not the merchant's products.**

Two facts that bound scope:
- **Nothing has ever run against a real Shopify store** — all fixture/injected-fetch tested (no golden HMAC vector, no live token exchange). The delegate token is *asserted* to authenticate a Storefront read; it has not been *proven* to.
- **Embed-key delivery is vestigial on the Shopify path** — the shipped theme snippet mints by shop domain (`data-shop` → `tenantForShopDomain`), never by key. So embed-key delivery is **not** on this milestone's critical path.

---

## 2. The change

### 2.1 Read-back with a demoted fallback (behind the existing ports)
`resolveShopifyStore` gains the **credential store** as its token source, with the `SecretsPort` key **demoted to a named fallback** (so the current demo/staging tenant, which has a hand-provisioned `shopify_storefront_token` and no install row, keeps serving). Token-resolution precedence **when the read-back flag is ON**:

1. `credentialStore.read(tenantId)`:
   - `found` → use `token` (+ the resolved domain) → **live** adapter.
   - `unreadable` (`undecryptable` | `malformed-record`) → **REFUSE** (see §2.2). Terminal — do **not** fall through to the fallback; an unreadable credential is a loud error, not a "try the other source."
   - `missing` → consult the fallback:
2. `SecretsPort.get(tenantId, "shopify_storefront_token")`:
   - present → creds → live adapter (the demo/staging path, unchanged).
   - absent → **missing** → fixtures (a merchant who never installed).

**When the flag is OFF:** `resolveShopifyStore` behaves **byte-identically to today** — `SecretsPort` only, `undefined` → fixtures. The credential store is not consulted. There is no "refuse" outcome. This keeps the change inert until it is live-proven.

### 2.2 Three-way outcome propagated to the router
Today `resolveShopifyStore` returns `ShopifyStoreCreds | undefined` and the router (`model.ts`) does `creds ? adapter : fixtures`. The read-back needs a **third** outcome, so the resolve result becomes a discriminated shape carrying:

- `found` → the live Shopify grounding adapter (the merchant's real catalog).
- `missing` → fixtures (safe: never-installed / demo tenant).
- `refuse` (from `unreadable`) → a **loud refusal**: `getContext` yields a distinct, **audited** refusal outcome the `/chat` path renders to the shopper as a graceful *"chat is temporarily unavailable"* — **never** the fixture catalog, **never** an unhandled crash. Carries the `reason` (`undecryptable` | `malformed-record`) into the audit/telemetry so an operator can see the cause.

The refusal is the whole point of the discriminated union the credential store already documents ("NEVER treat `unreadable` as `missing`"). A key misconfiguration must not masquerade as a merchant serving fixtures.

### 2.3 The dark gate
A single flag `MERCHANT_CRED_READBACK_ENABLED` (default **OFF**) gates §2.1. OFF is the current production behavior, unchanged. The flag is flipped **only after** the live proof (§3). (Global flag for this milestone — one merchant. Per-merchant enablement is a deferred follow-up, §6.)

### 2.4 Composition & the crypto key scope
- The serving composition root (`server.ts`) constructs `createMerchantCredentialStore(state, crypto)` (the same store install writes through) and injects its `read` into the grounding composition / `resolveShopifyStore`.
- This is the **first real caller** of the `merchant-cred` `CryptoPort` scope. The `CryptoPort` the composition builds must resolve the scope's secret — `MEMORY_ENCRYPTION_KEY__merchant-cred` per tenant (per the store header; `crypto-port.ts` requires the first non-default-scope caller to extend the documented scope list). The design **documents** this secret name in `DEPLOY.md` (it is an operator provisioning fact), and the read path must degrade to `unreadable`/`undecryptable` — i.e. **loud refusal**, not fixtures — if the scope key is unconfigured for a tenant that has a stored row.

### 2.5 Cache invalidation on provisioning
The grounding port is cached (`packages/platform-ports/src/grounding-cache.ts`, `createCachingGroundingPort`). A merchant flipped live must not stay on a cached fixture context for the TTL. The design adds a **cache-invalidation hook** keyed by tenant, invoked when a credential is provisioned/enabled (and on the flag flip for the target merchant), so the first grounded turn after go-live reflects the real catalog.

---

## 3. Live verification (the gate)

Because nothing has run live, the read-back stays dark until proven. Deliverable:

- **A self-contained live-verification harness** (a `tsx` CLI, mock-free): given real app credentials + a dev-store install, it runs the **actual** OAuth code exchange → `delegateAccessTokenCreate` → a **real Storefront product fetch** with the `Shopify-Storefront-Private-Token` header, and reports whether the delegate token authenticates a Storefront read (closes the "is the custodied token the right credential type/scope" question). It never writes to production stores and never logs the token.
- **A runbook** (in `DEPLOY.md`): `shopify app deploy` (register the app + host), set the install env vars, install on a dev store, run the harness, confirm, then flip `MERCHANT_CRED_READBACK_ENABLED`.

**Ownership.** The live proof is a **human/operator step** (it needs `shopify app deploy` + a dev store + the install env vars — infrastructure the build agent cannot provision). The build lands the read-back **dark** and unit-proven; the operator runs the harness and flips the gate. **Definition of Done for this milestone = code + harness + runbook, unit-proven, flag OFF.** The live flip is explicitly the operator's step, not a build deliverable.

---

## 4. Error handling & observability

| Outcome | Serving behavior | Observability |
|---|---|---|
| `found` | Live Shopify adapter (real catalog) | normal |
| `missing` (no cred, no fallback token) | Fixtures | none (expected) |
| `unreadable` → **refuse** | Graceful "temporarily unavailable" to the shopper | **audited/alarmable** with `reason`; never fixtures |
| Registry unreadable / region unset | Refuse (existing fail-closed behavior, unchanged) | existing |

Credential **reads are not audited** (hot path — the store documents this deliberately); the **refusal** is the audited/alarmable signal, not the read itself. No token, ciphertext, or key material is ever logged.

---

## 5. Testing

Unit (mock path, `env -u GOOGLE_CLOUD_PROJECT`; no real Vertex/Shopify):

1. **Three-way resolve** — `found` → live adapter selected; `missing` → fixtures; `unreadable{undecryptable}` and `unreadable{malformed-record}` → refuse (not fixtures).
2. **Fallback demotion** — flag ON + credential `missing` + `SecretsPort` token present → creds (demo tenant still served); flag ON + `missing` + no fallback → fixtures.
3. **Flag gating** — flag OFF → `resolveShopifyStore` byte-unchanged (SecretsPort only, `undefined` → fixtures); the credential store is never consulted.
4. **Refuse short-circuits the fallback** — `unreadable` + a present `SecretsPort` token → still refuse (unreadable is terminal).
5. **Router** — `model.ts` maps found/missing/refuse to adapter/fixtures/refusal; the refusal surfaces as the graceful shopper outcome.
6. **Cache invalidation** — a provisioned/enabled tenant is not served a stale cached fixture context.
7. The credential-store unit tests already cover `read()`'s union on both `RuntimeStatePort` adapters; reuse, do not duplicate.

**Integration proof:** the live harness (§3), run by the operator, is the end-to-end proof; it is not a CI gate.

---

## 6. Scope — explicitly deferred (not in this milestone)

- **Embed-key delivery** (vestigial on the Shopify path; only matters for standalone/non-Shopify embeds and the future console).
- **Merchant-console self-serve go-live** (needs the currently-unbuilt App-Bridge merchant-session auth; and a **self-serve** go-live would cross an NN#1 (money/model/business) boundary that `HITL-POLICY` does not currently name — that policy entry is a prerequisite, not part of this build).
- **Per-merchant read-back enablement** (this milestone uses one global flag).
- **Returns/shipping policy scope widening** (`DELEGATE_SCOPES_DEFAULT` covers products only; the Storefront scope that returns `shop.refundPolicy`/`shippingPolicy` is undocumented — a deliberate follow-up).
- **Embedded/App-Bridge iframe install** (blocked by the `SameSite=Lax` state cookie in the admin iframe).
- **The 7 boot preconditions** that gate whether the install routes are even registered in staging (`server.ts:897-905`) — an enablement/infra concern for the operator, tracked separately.

---

## 7. Constraints honored

- **Portability (ADR-0001 / NN#3):** the whole chain is already behind `GroundingPort` / `SecretsPort` / `MerchantRegistryPort` / `CryptoPort` / `RuntimeStatePort`. This change adds **no new port** and touches **no vendor SDK** — it wires an existing store's `read` into an existing resolve function.
- **Secrets & least privilege (NN#6):** the token is never in code/prompts/logs; it stays encrypted under the separate `merchant-cred` key scope; serving uses the Storefront API (published data only) with the private-token header, server-side only.
- **HITL (NN#1):** connecting a store and going live stays **operator-gated** (provision/flag), consistent with the current policy. This build does **not** add a self-serve go-live (that would need a HITL-POLICY entry first — §6).
- **Fail-closed / Kill Switch / Audit (NN#4/#5):** unchanged; the new refusal is fail-closed (refuse, don't degrade to fixtures) and audited.
- **No-auto-prod (NN#2):** the read-back ships **dark**; enabling is a human flip after a live proof.

---

## 8. Open items / assumptions

- **Shopify-API facts are consistent-with-docs, not proven** (repo cites shopify.dev retrieved 2026-08-05; no live call has run). Whether the delegate token authenticates a Storefront read **is** the thing the live harness (§3) proves; until it passes, the flag stays OFF. If the harness shows the delegate token does **not** authenticate a Storefront read, D2 becomes a re-mint problem (a scope/type fix at install), and this design's read-back is still correct plumbing — the harness is the guard that catches it before any shopper is affected.
- **The demo/staging tenant** keeps working throughout via the demoted `SecretsPort` fallback (it has no install row → `missing` → fallback).
