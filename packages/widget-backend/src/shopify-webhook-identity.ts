import { createHmac, timingSafeEqual } from "node:crypto";
import { SHOPIFY_PRODUCT_GID_PREFIX } from "./catalog-webhook-queue.js";

// C2 — Shopify WEBHOOK wire-format adapter. Lives here, next to shopify-install-identity.ts (C1) and the
// other named Shopify adapters, for the same reason they do: it is a Shopify-specific ADAPTER behind
// portable feature code — `node:crypto` only, NO Shopify SDK (ADR-0001, CLAUDE.md §3 NN#3). Nothing
// Shopify-shaped crosses out of this module: it hands upward plain strings and plain records.
//
// ****************************************************************************************************
// THIS IS *NOT* C1's SCHEME. C1 verifies a signed QUERY STRING (hex digest of a sorted, percent-encoded
// parameter list, in the `hmac` query parameter). A webhook is verified completely differently: a
// BASE64 digest of the UNPARSED REQUEST BODY, in a HEADER. shopify.dev says so in as many words on the
// authorization-code-grant page C1 cites: "The HMAC verification procedure for authorization code grant
// is different from the procedure for verifying webhooks." So none of C1's signer is reused here, and a
// future change must not "unify" them.
//
// PRIMARY SOURCES. Every wire-format detail below is quoted from one of these; nothing is from memory.
// All retrieved 2026-08-05.
//
// [W1] shopify.dev — "Verify webhook deliveries"
//      https://shopify.dev/docs/apps/build/webhooks/subscribe/https
//   • "Each HTTPS delivery includes a base64-encoded HMAC signature in the `X-Shopify-Hmac-SHA256`
//     header, generated using your app's client secret and the raw request body."
//   • "To validate manually, compute HMAC-SHA256 of the raw request body using your app's client secret
//     as the key, then compare it to the decoded header value. Reject any delivery where the signatures
//     don't match." The doc's own Node sample: `crypto.createHmac('sha256', appClientSecret)
//     .update(req.body).digest('base64')`, compared with `crypto.timingSafeEqual`, and on failure
//     `res.status(401)`.
//   • "Always verify HMAC before trusting payload contents."
//   • The two named pitfalls, verbatim: "Raw body parsing: HMAC verification requires the raw request
//     body. If you're using a body parser middleware like `express.json()`, it parses the body before
//     your verification code runs. Capture the raw body before it's parsed." and "Middleware order:
//     Place your webhook verification middleware before any body parsing middleware in your app."
//   • Duplicates: "Shopify minimizes duplicate deliveries, but your app might receive the same webhook
//     more than once… Process webhooks using idempotent operations so that receiving the same webhook
//     twice doesn't produce a different outcome. If your processing isn't idempotent, use the
//     `X-Shopify-Webhook-Id` header to detect and skip duplicates: Extract `X-Shopify-Webhook-Id`…
//     Check your persistent store for that ID. If it exists, skip processing and return a success
//     response. If it's new, process the delivery and save the ID."
//   • "If you have more than one subscription for the same topic, you'll receive a separate delivery per
//     subscription. Each has a different `X-Shopify-Webhook-Id` but shares the same
//     `X-Shopify-Event-Id`."
//   • Response contract: "Your system acknowledges receipt by sending Shopify a `200 OK` response. Any
//     response outside the 200 range, including 3XX codes, is treated as an error. Shopify has a
//     one-second connection timeout and a five-second timeout for the entire request."
//   • Retries: "If Shopify receives no response or an error, it retries 8 times over the next 4 hours.
//     After 8 consecutive failures, the subscription is automatically deleted if it was configured using
//     the Admin API."
//   • Secret rotation: "If you rotate your app's client secret, it can take up to an hour for the HMAC
//     digest to be generated using the new secret."
//
// [W2] shopify.dev — "Privacy law compliance" (the App Store requirement)
//      https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
//   • "Every app that's distributed through the Shopify App Store must subscribe to the following
//     compliance webhook topics: `customers/data_request` (Requests to view stored customer data),
//     `customers/redact` (Requests to delete customer data), `shop/redact` (Requests to delete shop
//     data)."
//   • "The app must handle POST requests with a JSON body and `Content-Type` header set to
//     `application/json`."
//   • "If a mandatory compliance webhook sends a request with an invalid Shopify HMAC header, then the
//     app must return a `401 Unauthorized` HTTP status." ← the 401 below is a LISTING REQUIREMENT.
//   • "If you don't provide URLs for the mandatory compliance webhooks, or your app doesn't respond to
//     these webhooks as required, then your app will be rejected."
//   • Response actions: "Confirm that you've received the request by responding with a `200` series
//     status code. Complete the action within 30 days of receiving the request. However, if you're
//     unable to comply with a redaction request because you're legally required to retain data, then you
//     shouldn't complete the action."
//   • `customers/data_request`: "The webhook contains the resource IDs of the customer data that you need
//     to provide to the store owner directly." — note: to the STORE OWNER, out of band; Shopify does not
//     ask the app to reply with the data.
//   • `shop/redact`: "48 hours after a store owner uninstalls your app, Shopify sends a payload on the
//     `shop/redact` topic. This webhook provides the store's `shop_id` and `shop_domain` so that you can
//     erase data for that store from your database."
//   • The three documented payload shapes are transcribed into `PAYLOAD_SHAPES` below.
//
// [W3] Shopify's OWN validator (Shopify-authored source; the only place the byte-level construction and
//      the exact header spelling are pinned down)
//      https://raw.githubusercontent.com/Shopify/shopify-app-js/main/packages/apps/shopify-api/lib/utils/hmac-validator.ts
//      https://raw.githubusercontent.com/Shopify/shopify-app-js/main/packages/apps/shopify-api/lib/types.ts
//      https://raw.githubusercontent.com/Shopify/shopify-app-js/main/packages/apps/shopify-api/lib/auth/oauth/safe-compare.ts
//   • `validateHmacFromRequestFactory`: `if (!rawBody.length) return fail(MissingBody)`;
//     `const hmac = getHeader(request.headers, hmacHeaderName); if (!hmac) return fail(MissingHmac);`
//     then `validateHmacString(config, rawBody, hmac, HashFormat.Base64)`, which is
//     `createSHA256HMAC(config.apiSecretKey, data, format)` + `safeCompare`.
//     ⇒ an EMPTY body is a failure, an ABSENT header is a failure, and the digest is BASE64 over the raw
//       body. There is NO timestamp tolerance on this path: `validateHmacTimestamp` is called only from
//       `validateHmac` (the query-string signator), never from the webhook path. So a webhook carries no
//       replay window of its own — see `WEBHOOK_REPLAY` below.
//   • `ShopifyHeader` (types.ts): `Hmac = 'X-Shopify-Hmac-Sha256'`, `Topic = 'X-Shopify-Topic'`,
//     `Domain = 'X-Shopify-Shop-Domain'`, `WebhookId = 'X-Shopify-Webhook-Id'`,
//     `ApiVersion = 'X-Shopify-API-Version'`, `EventId = 'X-Shopify-Event-Id'`.
//   • `safeCompare` compares only after `buffA.length === buffB.length`, then a constant-time loop.
//   • webhooks/validate.ts — `checkWebhooksHeaders` treats FIVE headers as REQUIRED on every delivery via
//     `getRequiredHeader(...)`: `hmac`, `topic`, `domain` (= `X-Shopify-Shop-Domain`), `apiVersion` and
//     `webhookId`; any missing one is `MissingHeaders`. That is the (Shopify-authored) evidence that
//     `X-Shopify-Shop-Domain` is present on EVERY topic including `app/uninstalled`, which is what makes
//     `APP_UNINSTALLED_SHOP_SOURCE` viable rather than a guess. It is still an UNSIGNED header — the HMAC
//     covers the body only — so "always present" is not "authenticated"; see that constant for the bound.
//     https://raw.githubusercontent.com/Shopify/shopify-app-js/main/packages/apps/shopify-api/lib/webhooks/validate.ts
//
// WHAT IS *NOT* VERIFIED, stated rather than implied:
//   • NO GOLDEN VECTOR. `shopify-webhook-identity` is tested against an independent transcription of
//     [W1]+[W3]; both sides share one reading, so that proves internal consistency, NOT byte-equality
//     with Shopify's live output. A real (secret, raw body, header) triple captured from an actual
//     delivery is still required before go-live — the same caveat C1 records for the OAuth signer and
//     shopify-shopper-identity.ts records for App-Proxy signatures.
//   • NO LIVE DELIVERY. Nothing in this repo has received a real Shopify webhook. Every test drives
//     `app.inject` with a locally-signed body.
//   • The `app/uninstalled` payload is NOT on [W2]; its shape is transcribed from the webhooks reference
//     (`https://shopify.dev/docs/api/webhooks/latest?reference=toml`, retrieved 2026-08-05), whose own
//     sample has `"domain": null` AND `"myshopify_domain": null`. That is a documentation SAMPLE, not an
//     observed live delivery — so this module treats the body as an unreliable source of the shop for
//     that topic and takes the shop from the header instead. See `APP_UNINSTALLED_SHOP_SOURCE`.
// ****************************************************************************************************

/**
 * WEBHOOK_REPLAY — the property C1 got from a timestamp and this cannot.
 *
 * C1's OAuth verifier refuses a validly-signed query older than ±90s ([W3]'s own tolerance), so a
 * captured install URL is not reusable tomorrow. A webhook delivery has NO signed timestamp:
 * `X-Shopify-Triggered-At` exists but is a HEADER, and the HMAC covers only the BODY, so an attacker who
 * obtained one valid (body, hmac) pair can rewrite that header freely. The compliance payloads
 * themselves carry no timestamp either ([W2]).
 *
 * So replay resistance here CANNOT come from freshness. It comes from two other places, and both are
 * implemented in routes/shopify-webhooks.ts rather than here:
 *   1. IDEMPOTENT ACTIONS — [W1]'s own first recommendation. Every action C2 takes is idempotent by
 *      construction: `setStatus(uninstalled)` only ever moves toward inert (it can never re-activate),
 *      and an erasure of already-erased data is a no-op.
 *   2. DELIVERY DEDUP by `X-Shopify-Webhook-Id` — which bounds DUPLICATE DELIVERY (Shopify retrying),
 *      not replay: the id is an unsigned header, so an attacker can vary it. Stated so nobody reads the
 *      dedup record as an anti-replay control.
 * A per-IP rate limit is the only thing that bounds a determined replayer's volume.
 */
export const WEBHOOK_REPLAY = "idempotent-actions + delivery-dedup; NOT freshness (no signed timestamp)" as const;

/** Header names, lowercased because Node lowercases incoming header keys. Spellings from [W3]. */
export const WEBHOOK_HMAC_HEADER = "x-shopify-hmac-sha256";
export const WEBHOOK_TOPIC_HEADER = "x-shopify-topic";
export const WEBHOOK_SHOP_HEADER = "x-shopify-shop-domain";
export const WEBHOOK_ID_HEADER = "x-shopify-webhook-id";

/** The three App-Store-mandatory compliance topics ([W2]) plus the revocation topic that makes an
 *  uninstall real. Exported so the composition root and the docs can name one list. */
export const COMPLIANCE_TOPICS = ["customers/data_request", "customers/redact", "shop/redact"] as const;
export const UNINSTALL_TOPIC = "app/uninstalled" as const;

/**
 * A3 (ADR-0020 D1/D4) — the catalog/inventory ingestion topics. Like `app/uninstalled`, their payload is
 * the changed object (a Product / an InventoryLevel), NOT a Shop, so the shop is taken from the SIGNED-
 * gated HEADER (see APP_UNINSTALLED_SHOP_SOURCE): the ONLY action they take is enqueue-a-reconcile, and
 * the worker RE-FETCHES that tenant's OWN catalog through that tenant's OWN creds — so a wrong header can
 * at worst trigger a redundant re-index of some other tenant's own data (what its own poll would do
 * anyway), never a cross-tenant read or write, and only a Shopify-HMAC-signed body reaches it at all.
 */
export const CATALOG_TOPICS = ["products/create", "products/update", "products/delete", "inventory_levels/update"] as const;

/**
 * W2-C — the order-attribution topics. `ORDER_TOPICS` fire on the same resource (a Shopify Order) at
 * two different lifecycle points; `REFUND_TOPIC` fires on a DIFFERENT resource (a Refund, keyed by
 * `order_id` back to its order) so its extraction helpers are separate (`refundOrderIdOf` /
 * `refundedAmountOf` below), mirroring how `productIdOf` and `customerIdOf` are separate reads over
 * different resource shapes rather than one polymorphic reader.
 *
 * ✔ FIELD NAMES VERIFIED against shopify.dev's REST Admin API resource docs (Order + Refund, `latest`,
 * retrieved 2026-08-19): an Order's `note_attributes` is an array of `{name, value}` objects,
 * `total_price` is a decimal string (e.g. `"409.94"`), and `currency` is the top-level order currency
 * code (`"USD"`); a Refund carries a top-level `id`, an `order_id` (its PARENT order), and a
 * `transactions[]` array whose entries carry a decimal-string `amount` (e.g. `"209.00"`). So the
 * extractors below read the correct fields. TWO caveats remain (the same "NO LIVE DELIVERY" class this
 * file's header carries for the compliance/catalog topics): (a) `read_orders` is deliberately not a
 * granted scope (see `routes/shopify-webhooks.ts`'s W2-C header), so no LIVE payload has ever been
 * captured against these extractors; (b) REST is a LEGACY API (2024-10) — a pre-enable check must
 * confirm the app's webhook API version/transport still delivers this REST-shaped body, since a
 * GraphQL webhook subscription can carry a different shape. Every extractor fails CLOSED (unattributed)
 * on any field it cannot read, so a shape mismatch degrades to no-measurement, never a wrong tally.
 */
export const ORDER_TOPICS = ["orders/create", "orders/updated"] as const;
export const REFUND_TOPIC = "refunds/create" as const;

/**
 * W3-3 — the Admin scope `webhookSubscriptionCreate` needs on the PARENT token to subscribe
 * `ORDERS_CREATE` / `ORDERS_UPDATED` / `REFUNDS_CREATE` ([S7]'s own per-topic-scope note in
 * shopify-install-identity.ts: "each TOPIC needs its resource read scope"). Named/exported (mirroring
 * `CATALOG_TOPICS`' own `read_products`/`read_inventory` pairing, documented in the same [S7] comment)
 * purely for DOCUMENTATION + a pinning test — nothing in this repo requests it automatically. The
 * decision this constant records: `read_orders` is requested (if at all) via the OPERATOR-CONTROLLED,
 * per-deployment `SHOPIFY_INSTALL_SCOPES` env var (server.ts, `docs/DEPLOY.md`) — NEVER via
 * `shopify.app.toml`'s static `[access_scopes]`, which is shared across every deployment including a
 * future production one. `order-attribution-scope-pinning.test.ts` pins both halves: the toml stays
 * untouched, and the code-level DEFAULT (`INSTALL_SCOPES_DEFAULT`) never includes this scope, so a
 * deployment that sets nothing new never requests it. Granting it for real ALSO requires completing
 * Shopify's protected-customer-data review — an owner-gated step this constant does not perform.
 */
export const ORDER_ATTRIBUTION_ADMIN_SCOPE = "read_orders" as const;

/**
 * Task 12 (ADR-0022 F3) — the least-privilege Admin OAuth scope set a PRODUCTION catalog-sync install
 * needs, and NOTHING more. Colocated with `ORDER_ATTRIBUTION_ADMIN_SCOPE` because both constants record
 * the SAME kind of decision (which Admin scope a specific sync capability needs) for a different
 * capability: order-attribution needs `read_orders`; catalog sync needs exactly these two.
 *
 * WHY THESE TWO AND NOTHING ELSE. [S7] (shopify-install-identity.ts, `webhookSubscriptionCreate`) documents
 * the per-topic scope requirement this repo's own `CATALOG_TOPICS` (above) subscribes to:
 * `PRODUCTS_CREATE`/`PRODUCTS_UPDATE`/`PRODUCTS_DELETE` → `read_products`, `INVENTORY_LEVELS_UPDATE` →
 * `read_inventory`. Catalog sync (the poll, the webhook reconcile, and the Bulk-Operations backfill,
 * catalog-index.ts / catalog-backfill.ts) only ever READS product/inventory data — it never calls a
 * Shopify Admin mutation — so a `write_*` scope would be strictly more privilege than the capability uses.
 * F3's boundary: no `write_products`/`write_customers`/`write_orders`/`write_inventory` scope may become a
 * CODE-LEVEL default for ANY install path (see the F3 pin in
 * `order-attribution-scope-pinning.test.ts`); `write_customers`/`write_orders` in `shopify.app.toml` today
 * are an owner-authorized, staging-DEV-app-only exception (that file's own W2-C comment) — never something
 * this constant, or a future production install, requests.
 *
 * NOT YET WIRED TO A LIVE SCOPE REQUEST. `routes/shopify-install.ts`'s `INSTALL_SCOPES_DEFAULT` today
 * requests only `unauthenticated_read_product_listings` (storefront, unrelated to Admin scopes) — there is
 * no production Admin-token install flow yet for this constant to feed (the current `deps.adminTokens.put`
 * call captures the SAME OAuth grant's `accessToken` already obtained for the delegate-token exchange; it
 * does not itself request Admin scopes). This constant exists now — pinned by test — so that whichever
 * task wires a production admin-sync scope request (Task 13) has an already-reviewed, least-privilege
 * value to reach for instead of inventing one inline.
 */
export const ADMIN_SYNC_SCOPES = ["read_products", "read_inventory"] as const;

/** The Storefront/Admin GID prefix for an Order node — used only if a future increment needs a
 *  GID-shaped id; the order-attribution KEY SPACE itself (below) deliberately does NOT use GIDs. */
export const SHOPIFY_ORDER_GID_PREFIX = "gid://shopify/Order/";

/** The cart `note_attribute` name the (out-of-scope) widget change attaches the opaque join token
 *  under. A leading underscore is Shopify's own convention for a note attribute hidden from the
 *  merchant-facing order-detail note-attributes display while remaining fully present on the API/
 *  webhook body — appropriate for an internal measurement key with nothing a merchant needs to see. */
export const JOIN_TOKEN_NOTE_ATTRIBUTE = "_palup_join_token";

/**
 * The order's own numeric id, as a bare decimal string, or `undefined`. Deliberately the BARE NUMBER
 * (not a GID like `productIdOf`) because it is the one field guaranteed derivable from BOTH an Order
 * body's `id` and a Refund body's `order_id` — using it as the shared key space means the order→arm
 * resolution map (`order-attribution-queue.ts`) never has to reconcile two differently-shaped ids for
 * the same order. Same refuse-rather-than-coerce / safe-integer discipline as `customerIdOf`.
 */
export function orderNumericIdOf(body: Record<string, unknown>): string | undefined {
  const id = body.id;
  if (typeof id === "number") return Number.isSafeInteger(id) && id >= 0 ? String(id) : undefined;
  if (typeof id === "string" && /^\d+$/.test(id)) return id;
  return undefined;
}

/**
 * The opaque join token from an Order body's `note_attributes` array (`[{name, value}, …]`), or
 * `undefined` if absent/malformed/blank. Never guessed, never coerced from another field — an order
 * that carries no such attribute (every order today, before the widget change ships) simply has no
 * token, which is the correct, honest "unattributed" input to the worker.
 */
export function joinTokenOf(body: Record<string, unknown>): string | undefined {
  const attrs = body.note_attributes;
  if (!Array.isArray(attrs)) return undefined;
  for (const entry of attrs) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    if (e.name !== JOIN_TOKEN_NOTE_ATTRIBUTE) continue;
    const value = e.value;
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

/** A non-negative finite amount from a Shopify money field, which is documented as a decimal STRING
 *  (e.g. `"409.94"`) on every Admin REST resource this file has seen; a JSON number is also accepted
 *  defensively. Anything else (missing, negative, NaN, `"abc"`) is `undefined` — refused, never
 *  coerced to 0 (a silent 0 would tally a real order as zero revenue rather than as unattributed). */
function moneyAmountOf(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** The order's total price (`total_price`), or `undefined` if missing/malformed. */
export function orderTotalOf(body: Record<string, unknown>): number | undefined {
  return moneyAmountOf(body.total_price);
}

/** The order's ISO-4217-shaped currency code, or `undefined`. Loose format check only (three upper-case
 *  letters) — this value is carried through to the ledger for display/audit, never parsed further. */
export function orderCurrencyOf(body: Record<string, unknown>): string | undefined {
  const c = body.currency;
  return typeof c === "string" && /^[A-Z]{3}$/.test(c) ? c : undefined;
}

/** A Refund body's parent order id (`order_id`), as a bare decimal string — the SAME key space
 *  `orderNumericIdOf` produces from an Order body, so a refund can look up the order→arm row the
 *  order webhook wrote. `undefined` if missing/malformed. */
export function refundOrderIdOf(body: Record<string, unknown>): string | undefined {
  const id = body.order_id;
  if (typeof id === "number") return Number.isSafeInteger(id) && id >= 0 ? String(id) : undefined;
  if (typeof id === "string" && /^\d+$/.test(id)) return id;
  return undefined;
}

/** A Refund body's OWN id (`id`), as a bare decimal string — distinct from `refundOrderIdOf` (the
 *  PARENT `order_id`). It is the per-refund idempotency key `applyRefund` claims on, so a redelivered
 *  refund (or one arriving under a different queue message id) cannot double-apply its negative delta,
 *  while two DIFFERENT (e.g. partial) refunds of the same order still each tally once. `undefined` if
 *  missing/malformed — a refund with no readable id is `"unattributed"`, never guessed. */
export function refundIdOf(body: Record<string, unknown>): string | undefined {
  const id = body.id;
  if (typeof id === "number") return Number.isSafeInteger(id) && id >= 0 ? String(id) : undefined;
  if (typeof id === "string" && /^\d+$/.test(id)) return id;
  return undefined;
}

/**
 * The refunded amount: the sum of `transactions[].amount` on a Refund body (each a money-string per
 * `moneyAmountOf`). Malformed/non-numeric entries are skipped rather than aborting the whole sum — a
 * refund body with at least one good transaction still yields a real (if partial) amount rather than
 * `undefined`. Returns `undefined` only when there is NO array or NOT ONE valid amount anywhere in it
 * — a body that provably refunded nothing must never be summed to a false `0` (0 is a valid completed
 * measurement; `undefined` is "could not read this body", and the two must never be confused).
 */
export function refundedAmountOf(body: Record<string, unknown>): number | undefined {
  const txns = body.transactions;
  if (!Array.isArray(txns)) return undefined;
  let total = 0;
  let sawValid = false;
  for (const t of txns) {
    if (t === null || typeof t !== "object" || Array.isArray(t)) continue;
    const amount = moneyAmountOf((t as Record<string, unknown>).amount);
    if (amount === undefined) continue;
    total += amount;
    sawValid = true;
  }
  return sawValid ? total : undefined;
}

/** The currency of the first valid refund transaction, or `undefined`. */
export function refundCurrencyOf(body: Record<string, unknown>): string | undefined {
  const txns = body.transactions;
  if (!Array.isArray(txns)) return undefined;
  for (const t of txns) {
    if (t === null || typeof t !== "object" || Array.isArray(t)) continue;
    const c = (t as Record<string, unknown>).currency;
    if (typeof c === "string" && /^[A-Z]{3}$/.test(c)) return c;
  }
  return undefined;
}

/**
 * Why `app/uninstalled` takes its shop from a header while every GDPR topic takes it from the body.
 *
 * The HMAC covers the BODY ONLY. So a body field is authenticated and a header is not. Every compliance
 * payload carries `shop_domain` IN THE BODY ([W2]), so every DESTRUCTIVE action in C2 is keyed off an
 * HMAC-covered value — no header trust anywhere near a deletion.
 *
 * `app/uninstalled` is the exception: its payload is a Shop object whose documented sample has
 * `myshopify_domain: null`, so the body may not name the shop at all. The header is the only source. That
 * trust is bounded and deliberate:
 *   • the ONLY action this topic takes is `setStatus(…, "uninstalled")` — FAIL-CLOSED (the merchant
 *     becomes inert, nothing is deleted) and REVERSIBLE with one CLI command;
 *   • so the worst outcome of a wrong header is a denial of service against one merchant that an
 *     operator can undo, not data loss and not an escalation of access;
 *   • and it is still gated on a valid HMAC, so only a party holding a Shopify-signed
 *     `app/uninstalled` body can reach it at all.
 * The reverse trade (refusing the topic because the body is unreliable) would leave an uninstalled
 * merchant servable forever — which is the exact gap `MerchantStatus` was added to close.
 */
export const APP_UNINSTALLED_SHOP_SOURCE = "header (X-Shopify-Shop-Domain) — the body may not carry it" as const;

/**
 * The `*.myshopify.com` allowlist. BYTE-IDENTICAL to C1's `SHOP_HOST` and to shopify-grounding.ts's, on
 * purpose: one host rule for every Shopify surface in this package, so a host the install flow would
 * refuse can never be revoked/redacted here under a different spelling. A trailing DNS root dot is
 * refused rather than stripped, because `pl_merchant` treats `acme.myshopify.com.` as a DISTINCT key
 * (postgres-merchant-registry.ts) — normalising it here would be the input side of a
 * two-tenants-one-store hazard.
 */
const SHOP_HOST = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

export function isValidShopDomain(value: unknown): boolean {
  return typeof value === "string" && SHOP_HOST.test(value);
}

/**
 * Read a header that must appear EXACTLY ONCE.
 *
 * Node hands back a `string[]` when a header arrived more than once. For a signature that is not an
 * inconvenience, it is a refusal: if `X-Shopify-Hmac-Sha256` appears twice there is no principled way to
 * decide which value Shopify sent, and picking `[0]` lets an attacker who can inject a header prepend
 * their own digest ahead of the real one. Same rule for the shop and webhook-id headers, since both feed
 * a decision. Returns `undefined` for absent / blank / array / non-string.
 */
export function singleHeader(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  return v.length > 0 ? v : undefined;
}

/**
 * Constant-time verification of a webhook delivery ([W1] "Manual verification", [W3]
 * `validateHmacFromRequestFactory`).
 *
 * Takes the RAW BODY AS BYTES. A `Buffer` parameter rather than a `string` is deliberate and
 * load-bearing: it makes it impossible for a caller to pass `JSON.stringify(req.body)` by accident,
 * which is the single most common way this check is silently broken (it passes on tidy input and fails
 * on any body whose bytes differ from a re-serialization — different key order, different whitespace,
 * a non-ASCII character escaped differently). The route obtains this Buffer from a content-type parser
 * that never parses ([W1]: "Capture the raw body before it's parsed").
 *
 * NEVER THROWS. A malformed digest is an unauthenticated request, not an exception — and an exception
 * here would turn the endpoint into an error-message oracle. FAIL CLOSED on a blank secret (an
 * unconfigured app must never accept a request signed with the empty key) and on an EMPTY body ([W3]
 * `MissingBody`): an empty string hashes to a fixed, publicly computable value under any known key, so
 * accepting one would be an open door the moment a secret leaked into a public sample.
 *
 * Compared as BASE64 TEXT rather than by decoding both sides. [W1]'s own sample decodes
 * (`Buffer.from(x, 'base64')`), but `Buffer.from` on invalid base64 SILENTLY DISCARDS the bad bytes —
 * so two different malformed headers can decode to the same short buffer, and a 1-byte decode compared
 * against a 32-byte digest is a length mismatch that happens to be safe today but is not a property
 * worth resting on. Comparing the canonical base64 text of our own digest against the header text is
 * strictly tighter: it rejects anything that is not the exact expected 44-character string.
 */
export function verifyWebhookHmac(secret: string, rawBody: Buffer, headerValue: unknown): boolean {
  try {
    if (typeof secret !== "string" || secret.length === 0) return false;
    if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) return false;
    const provided = singleHeader(headerValue);
    if (!provided) return false;
    const expected = createHmac("sha256", secret).update(rawBody).digest("base64");
    const a = Buffer.from(provided, "utf8");
    const b = Buffer.from(expected, "utf8");
    // Length first — `timingSafeEqual` throws on unequal lengths. A base64 sha256 digest is always 44
    // characters, which is public, so this leaks nothing an attacker does not already know.
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Parse the verified raw body into a plain object, or `null`.
 *
 * Called ONLY after `verifyWebhookHmac` returned true, so the bytes are known to come from Shopify —
 * but "from Shopify" is not "well-formed", and the parse is still the first place a hostile value could
 * appear if the secret ever leaked. Null-prototype output so an attacker-chosen key (`__proto__`,
 * `constructor`) cannot resolve or install an inherited value, mirroring C1's `normalizeOauthQuery`.
 * Arrays and scalars are rejected: every documented payload is a JSON object ([W2]).
 */
export function parseWebhookBody(rawBody: Buffer): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(rawBody.toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return Object.assign(Object.create(null) as Record<string, unknown>, parsed as Record<string, unknown>);
  } catch {
    return null;
  }
}

/**
 * PAYLOAD_SHAPES — the discriminators that stop CROSS-TOPIC REPLAY of a validly-signed body.
 *
 * THE ATTACK THIS EXISTS FOR. Both the URL and `X-Shopify-Topic` are chosen by whoever sends the
 * request; only the body is HMAC-covered. A `customers/redact` body is a superset of a `shop/redact`
 * body (both carry `shop_id` + `shop_domain`), so a party holding ONE validly-signed customer redaction
 * could POST it at the shop-redact path and escalate a single-customer erasure into a whole-merchant
 * revocation + tenant-wide erasure. Checking the topic header would not help — it is as forgeable as the
 * URL. The only non-forgeable discriminator is the body itself.
 *
 * So each topic declares which keys its documented payload MUST have and which it must NOT, and the
 * required/forbidden sets are chosen so that no documented payload satisfies more than one topic:
 *   • `data_request.id` is present ONLY on `customers/data_request` ([W2]) — it is that request's own
 *     identifier, so a genuine one always has it and nothing else ever does.
 *   • `customer` is present on BOTH customer topics and on neither shop topic.
 *   • `shop_domain` is present on all three compliance topics and NOT in the `app/uninstalled` Shop
 *     object (which spells its host `myshopify_domain`/`domain`).
 * Result: every one of the 12 wrong-path combinations is refused, and each is covered by a test.
 *
 * `orders_to_redact` / `orders_requested` are deliberately NOT required. Both are order-id lists, and a
 * customer with no orders plausibly yields an empty or absent array; requiring one would refuse a
 * legitimate delivery, which for a mandatory compliance topic is the worse failure.
 */
export interface PayloadShape {
  required: readonly string[];
  forbidden: readonly string[];
}

export const PAYLOAD_SHAPES: Record<string, PayloadShape> = {
  "customers/data_request": { required: ["shop_domain", "customer", "data_request"], forbidden: [] },
  "customers/redact": { required: ["shop_domain", "customer"], forbidden: ["data_request"] },
  "shop/redact": { required: ["shop_domain"], forbidden: ["customer", "data_request", "orders_requested", "orders_to_redact"] },
  // A shop payload's own domain fields may be null (see APP_UNINSTALLED_SHOP_SOURCE), so this shape stays
  // FORBIDDEN-only rather than requiring a positive shop field. But it must still exclude the OTHER signed
  // body classes so one cannot be replayed here: compliance bodies carry shop_domain/customer/data_request,
  // and — A3 (security review) — product/inventory bodies carry title/handle/variants/inventory_item_id.
  // A genuine Shop object carries NONE of these, so forbidding them cannot reject a real uninstall, but it
  // stops a captured, validly-signed catalog delivery from being replayed here to make a merchant inert.
  [UNINSTALL_TOPIC]: {
    required: [],
    forbidden: ["shop_domain", "customer", "data_request", "title", "handle", "variants", "inventory_item_id", "order_id", "transactions"],
  },
  // A3 — catalog/inventory bodies. Discriminators only (the worker re-fetches, never trusting the body);
  // `forbidden` keeps a compliance body (shop_domain/customer/data_request) AND — W2-C — a Refund body
  // (`order_id`/`transactions`, which carries no forbidden compliance field of its own) from ever
  // matching a catalog topic. Without this, a validly-signed `refunds/create` body (bare `id` +
  // `order_id` + `transactions`, no `customer`/`shop_domain`) would satisfy products/create's OLD
  // required-only-"id" shape and could be replayed there — caught by this file's own cross-topic test.
  "products/create": { required: ["id"], forbidden: ["shop_domain", "customer", "data_request", "order_id", "transactions"] },
  "products/update": { required: ["id"], forbidden: ["shop_domain", "customer", "data_request", "order_id", "transactions"] },
  "products/delete": { required: ["id"], forbidden: ["shop_domain", "customer", "data_request", "order_id", "transactions"] },
  "inventory_levels/update": { required: ["inventory_item_id"], forbidden: ["shop_domain", "customer", "data_request"] },
  // W2-C — an Order body carries `id` + `note_attributes` + `total_price` together; nothing else in
  // this table's documented shapes does (a Refund has `order_id`/`transactions`, never `total_price`;
  // a compliance body has `shop_domain`, which an Order never carries — see APP_UNINSTALLED_SHOP_SOURCE
  // for why this file already treats an Order-shaped body's shop as HEADER-sourced, same reasoning).
  // `orders/create` and `orders/updated` are the SAME resource shape (mirrors products/create vs
  // products/update above) — the topic, not the body shape, is what tells the two apart.
  "orders/create": { required: ["id", "note_attributes", "total_price"], forbidden: ["shop_domain", "data_request", "order_id", "transactions"] },
  "orders/updated": { required: ["id", "note_attributes", "total_price"], forbidden: ["shop_domain", "data_request", "order_id", "transactions"] },
  // A Refund carries `order_id` (its PARENT order's id) + `transactions`; an Order never carries
  // `order_id` (it IS the order, not a reference to one) — the cleanest discriminator from the two
  // topics directly above.
  "refunds/create": { required: ["id", "order_id"], forbidden: ["shop_domain", "customer", "data_request", "note_attributes", "total_price"] },
};

/** True when `body` matches exactly the shape this topic's documented payload has. Own-property checks
 *  only (the body is null-prototype anyway), and a `null` value does not satisfy `required` — a
 *  `"customer": null` must not pass for a topic that needs a customer. */
export function matchesPayloadShape(topic: string, body: Record<string, unknown>): boolean {
  const shape = PAYLOAD_SHAPES[topic];
  if (!shape) return false;
  for (const k of shape.required) if (!Object.hasOwn(body, k) || body[k] === null || body[k] === undefined) return false;
  for (const k of shape.forbidden) if (Object.hasOwn(body, k)) return false;
  return true;
}

/** The HMAC-COVERED shop domain, lowercased, or `undefined`. Used by all three compliance topics. */
export function bodyShopDomain(body: Record<string, unknown>): string | undefined {
  const raw = body.shop_domain;
  return isValidShopDomain(raw) ? (raw as string).toLowerCase() : undefined;
}

/**
 * The customer id as a BARE DECIMAL STRING, or `undefined`.
 *
 * [W2]'s samples show `"id": 191167` — a JSON NUMBER, so a string is not enough. Accepts a number only
 * when it is a non-negative safe integer (a float or a value beyond 2^53 would have already lost
 * precision on the way in, and silently truncating a customer id would erase the WRONG customer), and a
 * string only when it is all digits. Everything else — `null`, an object, a GID, a path fragment, an
 * empty string — is `undefined`, so it can never be interpolated into a namespace. This is the same
 * refuse-rather-than-coerce posture `buildShopifyShopperId` applies with its own `/^\d+$/`, which is the
 * next gate this value passes through.
 */
export function customerIdOf(body: Record<string, unknown>): string | undefined {
  const c = body.customer;
  if (c === null || typeof c !== "object" || Array.isArray(c)) return undefined;
  const id = (c as Record<string, unknown>).id;
  if (typeof id === "number") {
    return Number.isSafeInteger(id) && id >= 0 ? String(id) : undefined;
  }
  if (typeof id === "string" && /^\d+$/.test(id)) return id;
  return undefined;
}

/**
 * S3 §C, fix round 2 (SUPERSEDES fix round 1's "return the bare numeric id" ruling) — the changed
 * product's FULL Storefront/Admin GID (`"gid://shopify/Product/<id>"`), or `undefined`.
 *
 * WHY THE FULL GID, NOT THE BARE NUMBER. The corpus/ledger record key is `product:<FULL-GID>`
 * (`catalogRecordId`, catalog-index.ts — built from the Storefront GID the full-catalog index path reads
 * off `Product.id`), and Shopify's `nodes(ids:)` (the by-id fetch, Task 4) REQUIRES a GID, not a bare
 * number. Fix round 1 had this function strip the GID down to its bare numeric tail, which built the
 * WRONG record id (`product:123` never matches the real `product:gid://shopify/Product/123` key) and sent
 * an invalid id to `nodes(ids:)` — the targeted reconcile would silently never refresh the changed
 * product. Returning the whole GID string end-to-end fixes both: it IS the corpus key's id half, and it
 * IS what `nodes(ids:)` expects.
 *
 * PRECISION IS UNCHANGED BY THIS FIX. Shopify's product webhook body carries the id in TWO fields: the
 * numeric `id` (a JSON number, so it is already lossy for a large id — `JSON.parse`/the JS number type
 * both round any integer beyond `Number.MAX_SAFE_INTEGER` before this function ever sees it) and
 * `admin_graphql_api_id`, a GID STRING `"gid://shopify/Product/<id>"` — a string is never subject to
 * float64 rounding. The GID string is read FIRST, as the precision-safe source, and returned VERBATIM
 * (never parsed apart and never reassembled) — so an oversized id stays byte-exact. The numeric `id`
 * field is a LAST-RESORT FALLBACK only, for a body that somehow lacks the GID: when it is used, this
 * function CONSTRUCTS the GID (`SHOPIFY_PRODUCT_GID_PREFIX + String(id)`) so the return type is always a
 * full Product GID or `undefined`, never a bare number — one id convention, not two. The fallback keeps
 * the exact same safe-integer refusal `customerIdOf` uses (never silently rounds a value that has
 * already lost precision).
 *
 * Same refuse-rather-than-coerce discipline as `customerIdOf`/`dataRequestIdOf` throughout: a value that
 * does not exactly match the expected shape yields `undefined`, never a guess.
 */
export function productIdOf(body: Record<string, unknown>): string | undefined {
  const gid = body.admin_graphql_api_id;
  if (typeof gid === "string" && /^gid:\/\/shopify\/Product\/\d+$/.test(gid)) return gid;
  // Fallback only — no valid GID present. Same safe-integer discipline as customerIdOf: a numeric id
  // beyond Number.MAX_SAFE_INTEGER has already lost precision by the time it is a JS number, so it is
  // refused rather than silently rounded. Constructed into a full GID, never returned bare.
  const id = body.id;
  if (typeof id === "number") return Number.isSafeInteger(id) && id >= 0 ? `${SHOPIFY_PRODUCT_GID_PREFIX}${id}` : undefined;
  if (typeof id === "string" && /^\d+$/.test(id)) return `${SHOPIFY_PRODUCT_GID_PREFIX}${id}`;
  return undefined;
}

/** The `data_request.id` as a bare decimal string ([W2]: `"data_request": { "id": 9999 }`), or
 *  `undefined`. Same numeric discipline as `customerIdOf`, and for the same reason: it becomes a KV key. */
export function dataRequestIdOf(body: Record<string, unknown>): string | undefined {
  const d = body.data_request;
  if (d === null || typeof d !== "object" || Array.isArray(d)) return undefined;
  const id = (d as Record<string, unknown>).id;
  if (typeof id === "number") return Number.isSafeInteger(id) && id >= 0 ? String(id) : undefined;
  if (typeof id === "string" && /^\d+$/.test(id)) return id;
  return undefined;
}
