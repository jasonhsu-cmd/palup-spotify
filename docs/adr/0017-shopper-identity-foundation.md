# ADR-0017: Shopper-identity foundation (M2) — layered, portable behind the identity port

- **Status: Accepted — built and live on internal staging (`SHOPPER_AUTH` on); NOT a HITL/autonomy change.** Records the port contract and
  the first-slice Shopify-customer adapter that give every `/chat` request a **server-verified shopper
  principal**. It ships **no new autonomy and no durable shopper memory** — it is the load-bearing
  prerequisite for ADR-0016 enforcement prerequisite #1 (a real owner to authorize skip/pause against)
  and ADR-0015 Tier 2 (a stable per-tenant account id).
- **Owner (named, CLAUDE.md §5):** jason.hsu@framy.co.
- **Plane:** build-time (a new capability on the portable `IdentityPort`) **and** run-time (identity now
  governs `relationship` + authorizes account-scoped reads). **Customer data → governed** (`HITL-POLICY`,
  CLAUDE.md §3/§7). Not a self-improvement candidate ⇒ **not** in the evolution pipeline.
- **Decision (owner):** the auth mechanism is **LAYERED** — Shopify customer session AND widget
  passwordless (email magic-link / OTP), both behind one `IdentityPort`. **First slice = the
  Shopify-customer adapter only** (subscribers ARE Shopify customers ⇒ it natively covers ADR-0016 with
  zero friction for logged-in shoppers). OTP + the Customer Account API are designed-in second adapters,
  not first-slice code.

## Context

Today the widget token authenticates only the **merchant** (`widget-token-identity.ts:46` →
`{kind:"merchant", merchantId}`); the shopper is unauthenticated. `deriveServingSignals` hardcodes
`relationship:"anonymous"` (`signals.ts:45`) and the brain is constructed with a constant
`shopperId = "shopper-demo"` (`brain.ts:372`, `server.ts:119`) that flows into the ownership check
`found.shopperId !== shopperId` (`support.ts:69`). So the "verified-owned subscription" check is vacuous —
a constant compared to itself — and ADR-0016 prerequisite #1 is unmet. ADR-0015 Tier 2 needs a stable
per-tenant account id to merge guest facts into and to derive VIP/subscriber/lapsed from order history
(`0015:45-50`). Both are blocked on one thing: a **per-request, server-verified shopper id**.

## Decision

### 1. Port contract — extend `IdentityPort` / `Principal`, do not fork it

Extend the existing union (`identity-port.ts`) with a shopper case:

```
Principal =
  | { kind: "operator";  operatorId: string }
  | { kind: "merchant";  merchantId: string }
  | { kind: "shopper";   shopperId: string; source: "shopify" | "otp"; verified: true }
  | { kind: "anonymous" }
```

- **`verifyShopper(credential) → Promise<Principal>`** — returns a `{kind:"shopper", verified:true}` or
  `{kind:"anonymous"}`; never merchant/operator, **never throws** (unauthenticated is anonymous, not an
  error — same contract as `authenticate`). Realized as adapters satisfying `IdentityPort`.
- **Server-derived only.** A shopper credential is UNTRUSTED input verified server-side; a client-supplied
  `shopperId` is never trusted (extends the T7 trust boundary in `signals.ts`/`server.ts`).
- **`shopperId` namespace (load-bearing):** `shopify:<merchantId>:<logged_in_customer_id>`. Shopify's
  customer id is stable but unique **per store**, so it MUST be namespaced by the already-verified merchant
  tenant. This is the identity ADR-0015 keys its per-tenant account namespace on and ADR-0016 authorizes
  ownership against. OTP later yields `otp:<merchantId>:<emailHash>` — same shape. **Collision-safety
  (F6):** validate the components at construction — `merchantId` ∈ `[a-z0-9-]+`, `customerId` ∈ `\d+` —
  and reject anything else to anonymous, so `shopify:a:b` can never be ambiguous with a different
  (tenant, cid) split (`merchantId` comes from operator config and could otherwise contain a `:`).
- **`authorize` (least privilege, default-deny):** a `verified` shopper may perform `account:*` /
  `shopper:self:*` for **its own** id only; anonymous ⇒ false; a shopper may never perform
  `merchant:*`/`widget:*`/`operator:*`. Fine-grained which-record ownership stays in the commerce/support
  layer (`support.ts:69`), not in `authorize`.

### 2. First slice — Shopify-customer adapter (App Proxy HMAC + `logged_in_customer_id`)

Server-side verification (no shopper friction, no network round-trip, deterministic ⇒ testable now):

1. Take the App Proxy query params; separate `signature` from the rest.
2. Recompute HMAC-SHA256 over the remaining params (Shopify's sort+concatenate scheme) keyed by the **app
   shared secret** (via the `SecretsPort`, never env-in-repo/logs — mirrors the Storefront token wiring);
   constant-time compare to `signature`. Mismatch ⇒ **anonymous** (fail-closed).
3. Reject a stale `timestamp` (anti-replay) ⇒ anonymous — **short max-age (a few minutes) with
   clock-skew tolerance, and reject FUTURE timestamps (F5)**; a single-use nonce at `/shopper/session`
   is an impl option. (A captured signed proxy URL could otherwise be replayed within the window to mint
   a shopper token as the victim; TLS + short TTL bound the blast radius to the victim's own short-TTL token.)
4. Empty/absent `logged_in_customer_id` ⇒ anonymous (shopper is browsing, not logged in).
5. Resolve `shop` → tenant (reuse the `SHOPIFY_STORES` map) and **cross-check it equals the request's
   verified widget-token tenant**; mismatch ⇒ anonymous (prevents binding store A's shopper into store B).
6. Emit `{kind:"shopper", shopperId:"shopify:<tenant>:<cid>", source:"shopify", verified:true}`.

**Trust boundary:** the credential is Shopify-signed data; PalUp verifies the signature and derives the id
— nothing shopper-typed comes from a client-set field. **Failure = anonymous, always.**

**Testable contract now, real path spike-gated.** The adapter's crypto (HMAC, constant-time, replay,
cross-shop, empty-id) is proven by a deterministic test that mints params with a known secret using the
SAME routine. The **only** piece unverified this session is Shopify's exact wire concatenation (see the
honesty note); it is confined to one function and gated before the adapter points at live traffic — the
stub is not eval-theater, but the live cutover waits on the spike (T2b).

**Transport (F1 — domain-separated, re-bound at /chat).** `/chat` stays a cheap HMAC check: a
`/shopper/session` endpoint (reached via the App Proxy) runs steps 1–6 once and mints a short-TTL
**PalUp-signed shopper session token** carrying the verified `shopperId`+`source`. The widget sends it on
`/chat` (Bearer) alongside the merchant token; `/chat` verifies it with a constant-time HMAC. Two
**required** controls (without them this is a privilege-escalation / cross-tenant hole):
- **Token-type separation.** The shopper token carries a mandatory `typ:"shopper"` claim and BOTH
  verifiers strictly enforce their type: the *merchant* verifier rejects any token whose `typ !== "widget"`,
  the *shopper* verifier rejects `typ !== "shopper"`. (Otherwise a shopper token — which must carry the
  merchant tenant — fed to the merchant verifier keying on `payload.m` would yield a **merchant** principal
  and escalate a shopper to merchant/widget scope.) Domain-separate keys are an acceptable alternative.
- **/chat tenant re-binding.** The `shop`↔tenant cross-check at mint (step 5) is not enough; at /chat, parse
  the tenant prefix out of the verified `shopperId` (`shopify:<tenant>:…`) and **require it equals the /chat
  verified widget-token tenant**, else degrade to an anonymous shopper. (Prevents presenting a
  `shopify:A:123` token on a session authenticated as tenant B — a cross-tenant identity binding, and once
  ADR-0015 memory keys off this id, a cross-tenant write.) Deriving the tenant from the prefix means no
  separate `m` field is added to the shopper token.

**OTP reuses this transport unchanged** — only steps 1–6 are swapped ⇒ "OTP slots in without rework."

### 3. Wiring

- `ServingSignalContext` gains a server-derived `shopperId?` + `verified` flag; `deriveServingSignals` sets
  `shopperId` from ctx (overwriting any client value) and derives `relationship`: verified ⇒ `"new"` (a
  known account, history not yet loaded — **no VIP/subscriber uplift**); anonymous ⇒ `"anonymous"`
  (unchanged). VIP/subscriber/lapsed enrichment from order history is **ADR-0015 Tier 2, keyed off this
  shopperId — NOT this slice** (promoting a freshly-verified shopper to VIP here would assert an unearned
  relationship).
- `Signals` gains `shopperId?` with the same "server-derived, `deriveServingSignals` is the only origin"
  contract as `tenantId`. The brain reads `signals.shopperId` for the support/commerce path; the
  constructor `"shopper-demo"` degrades to the anonymous rollout fallback only.
- **ADR-0016 GUARD (fail-closed).** **ANY** non-mock/live commerce or subscription adapter — **reads AND
  writes** (F2: a live cross-account READ, e.g. `getRecentOrder`/`getOrder` against a constant/unverified
  id, is already an IDOR disclosure, no mutation required) — MUST NOT be used behind an unverified or
  constant shopperId. A guard checks the Principal (not a string): live adapter +
  non-`{kind:"shopper",verified:true}` ⇒ refuse (throw at construction / degrade to anonymous, no live
  account read). The first slice uses `MockCommerceAdapter` ⇒ the guard is a tested no-op, but the
  invariant is now in code so a future live-adapter PR cannot skip it.

### 4. Privacy / consent + governance

- Identifying a shopper is personal data (GDPR). **Resolving identity for the current request** (to
  authorize the shopper's own account action / show their own order) is processing necessary for the
  requested service — it stores nothing cross-visit. **Durable shopper memory is out of scope** and stays
  governed by ADR-0015 (region ∈ {eu, unknown} fail-closed); this slice writes no fact.
- **Audit (§3.5).** Each resolution emits `identity.shopper.resolved` (actor, source, verified, tenant,
  reversal="n/a — read-only identity"), with the shopperId reduced to a ref via a **keyed HMAC** (a
  server-held key), not a bare SHA-256 (F7 — `shopify:<knownMerchant>:<numeric cid>` is low-entropy and an
  unsalted hash is brute-forceable). Describe the ref as **pseudonymous, not de-identified**; keep raw
  `shop`/`logged_in_customer_id` out of any verifier debug/error log; note the transport token body is
  base64 (integrity-protected, **not confidential**) and embeds the numeric cid — hence short TTL and no
  email/PII in the body. (The existing `sessionRef` unsalted-hash weakness is worth fixing together.)
- **Least privilege:** account-self scope only. The App Proxy shared **secret is app-scoped (a single
  secret, NOT per-tenant), via the `SecretsPort`** — its compromise forges shopper identity for *every*
  merchant, a higher blast radius than the per-tenant Storefront token (F8), so: rotation + access-logging,
  and never env-in-repo/logs. **Kill switch unaffected** (identity is resolved independent of the kill
  check; precedence unchanged).
- Whole slice is gated behind a `SHOPPER_AUTH` posture flag (mirrors `WIDGET_AUTH_REQUIRED`). **Default off
  ⇒ every shopper is anonymous and behavior is byte-identical to today.** `SHOPPER_AUTH` is **only honored
  when `WIDGET_AUTH_REQUIRED` is on** (F4 — it needs a *verified* widget tenant to cross-check against;
  under the unauthenticated `RUNTIME_TENANT` fallback the tenant check is vacuous), enforced as a startup
  precondition.

### 5. What it unblocks — and what it explicitly does NOT do

Unblocks: ADR-0016 prereq #1 (a real owner to authorize skip/pause against) and ADR-0015 Tier 2 (a stable
per-tenant account id to merge into / derive relationship from).

Out of scope (follow-ons): account-management UI; OTP verifier code (designed-in, not built); the
subscription skip/pause **execution** itself (still human-routed per ADR-0016 until its full checklist +
`security-reviewer` + `agent-evolution-steward` sign-off); durable cross-visit memory + consent UX
(ADR-0015); the Customer Account API adapter; the guest→account merge.

## Shopify mechanism — honesty calibration

- **CONFIRMED (shopify.dev, 2026-07-31):** an App Proxy exposes `logged_in_customer_id` + `shop` as query
  params on the proxied storefront request; `authenticate.public.appProxy` (official library) validates
  app-proxy requests server-side; the Customer Account API uses OAuth 2.0 (+ PKCE) with an `id_token` JWT.
- **UNVERIFIED — recollection, needs spike T2b before live cutover:** (a) **the linchpin (F3):** that
  `logged_in_customer_id` is **within the HMAC-signed param set** — if Shopify does NOT sign it, an
  attacker with any validly-signed proxy URL can append/alter it and the identity is forgeable; (b) the
  exact `signature` algorithm (param `signature`, HMAC-SHA256 over the remaining params sorted
  lexicographically and concatenated `key=value` with no separator, keyed by the app shared secret, hex
  constant-time compare); (c) whether the merchant must enable new Customer Accounts for
  `logged_in_customer_id` to populate. Could not be re-confirmed from primary source this session; the
  testable stub proves the security invariants regardless, so only the real-request trust rests on the
  spike — **the live cutover stays blocked until (a) is confirmed in particular.**

## Alternatives considered

- **Customer Account API (OAuth2/PKCE) as the first adapter.** Richer, off-storefront; but the merchant
  must enable new customer accounts, it needs real OAuth + network verification (not deterministically
  testable), and it adds a login redirect. The richer fast-follow adapter behind the same port.
- **A PalUp-minted shopper token as the primary credential.** Trivially testable but proves no Shopify
  identity — it would assert identity PalUp never verified, failing ADR-0016's "server-verified, never
  client-set" at the source. Rejected as the root credential; reused only as the post-verification
  transport token.
- **Store durable shopper memory in this slice.** Rejected — that is ADR-0015, consent/region-gated and
  legally blocked; folding it in here would ship an unconsented write.

## Consequences

- (+) ADR-0016 and ADR-0015 Tier 2 are unblocked by one small, reversible, portable subsystem.
- (+) OTP and the Customer Account API are new adapters, not rewrites (ADR-0001); Shopify specifics are
  contained to `shopify-shopper-identity.ts`.
- (−) Requires routing shopper-verified requests through the storefront App Proxy (embed/infra change),
  gated behind `SHOPPER_AUTH`; the direct/anonymous path is unchanged.
- (−) The exact App Proxy signature wire-format is UNVERIFIED this session (spike T2b) before live cutover.
- (−) The whole slice needs `security-reviewer` sign-off (identity/authz + customer data + the ADR-0016 gate).

## Governance sign-off

- **Design security review (done, 2026-07-31) — `security-reviewer`, verdict DESIGN-SOUND-WITH-CHANGES.**
  Folded into this ADR: **F1** token-type separation + /chat tenant re-binding (was a cross-tenant
  privilege-escalation), **F2** guard covers reads not just writes, **F3** the `logged_in_customer_id`-in-
  signed-set linchpin as a named T2b AC, **F4** `SHOPPER_AUTH`⇒`WIDGET_AUTH_REQUIRED`, **F5** replay bound,
  **F6** namespace validation, **F7** keyed-HMAC audit ref, **F8** app-scoped-secret blast radius. A
  fresh `security-reviewer` pass still runs on the implementation PR(s) below.
- **`security-reviewer`** — REQUIRED across the slice (authz surface, credential verification/replay,
  token, IDOR/ownership, the fail-closed money-adjacent guard, immutable-log PII).
- **`agent-evolution-steward`** — NOT required for this slice (no run-time behavior candidate, no new
  autonomy); becomes required at ADR-0016 enactment.
- **Named owner (jason.hsu@framy.co)** merges — governance-touching (identity + the ADR-0016 gate).

## First-slice task list (ATDD — write the red tests first)

`[P]` = parallelizable in its wave; **SR** = `security-reviewer` sign-off required.

- **T0** — land this ADR (human-merged). AC: file exists, Status Proposed, owner named.
- **T2b [P]** — spike: confirm from shopify.dev **(named AC, F3) that `logged_in_customer_id` is within the
  HMAC-signed param set** (the linchpin), plus the exact `signature` algorithm + the Customer-Accounts
  requirement. AC: a cited (URL + date) note confirms the linchpin, or it stays flagged and T2's live
  cutover stays blocked.
- **T1** — Principal + `authorize` extension (`identity-port.ts`, `index.ts`). Tests: shopper Principal
  typechecks; `authorize(verifiedShopper,"account:read")===true`; anonymous→false; shopper→`merchant:*`/`widget:*`
  →false. **SR.**
- **T2 [P]** — Shopify App Proxy shopper verifier (`shopify-shopper-identity.ts`). Tests: valid sig +
  non-empty cid + shop→tenant ⇒ namespaced shopper; tampered/empty/stale/cross-shop ⇒ anonymous; never
  throws. **SR** (carries the T2b spike gate).
- **T3 [P]** — shopper session token transport (`shopper-token-identity.ts`). Tests: mint→`authenticate`
  round-trips to the shopper Principal; expired/tampered ⇒ anonymous (constant-time). **SR.**
- **T4** — `/shopper/session` mint + `/chat` shopper-token wiring behind `SHOPPER_AUTH` (`server.ts`).
  Tests: valid App-Proxy request → token; `/chat` with it → shopper principal; client-set `shopperId`
  ignored; off ⇒ no behavior change. **SR.**
- **T5** — `deriveServingSignals` server-derived `shopperId`+`relationship` (`signals.ts`, `types.ts`).
  Tests: client `shopperId`/`relationship:"vip"` dropped; verified ctx ⇒ `relationship:"new"`; anonymous ⇒
  unchanged. **SR** (trust boundary).
- **T6** — brain uses per-request `shopperId` (`brain.ts`). Tests: with `signals.shopperId="A"`, an order
  owned by `"B"` is denied regardless of the constructor default. **SR** (IDOR).
- **T7 [P]** — fail-closed live-commerce guard (ADR-0016 gate) (`model.ts`, `commerce-guard.ts`,
  `server.ts`). Tests: a live adapter behind anon/unverified ⇒ fail closed for a **READ** (`getRecentOrder`)
  as well as a write (F2); live + verified ⇒ ok; mock ⇒ ok. **SR.**
- **T8 [P]** — identity-resolution audit, PII-safe (`audit.ts`, `server.ts`). Tests: a verified turn writes
  `identity.shopper.resolved` with a **hashed** ref (no raw id); anonymous turns add no noise. **SR.**
- **T9 [P]** — cross-link ADR-0016 prereq #1 / ADR-0015 Tier 2 / the HITL note to ADR-0017 (docs,
  human-merged).

Dependency graph: T0 → T1 → {T2, T3} → T4 → T5 → T6 → {T7, T8}; T2b/T9 parallel.
