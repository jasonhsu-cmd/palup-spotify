import { createHmac, timingSafeEqual } from "node:crypto";

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
    forbidden: ["shop_domain", "customer", "data_request", "title", "handle", "variants", "inventory_item_id"],
  },
  // A3 — catalog/inventory bodies. Discriminators only (the worker re-fetches, never trusting the body);
  // `forbidden` keeps a compliance body (shop_domain/customer/data_request) from ever matching a catalog
  // topic and vice-versa. products/* carry `id`; inventory_levels/update carries `inventory_item_id`.
  "products/create": { required: ["id"], forbidden: ["shop_domain", "customer", "data_request"] },
  "products/update": { required: ["id"], forbidden: ["shop_domain", "customer", "data_request"] },
  "products/delete": { required: ["id"], forbidden: ["shop_domain", "customer", "data_request"] },
  "inventory_levels/update": { required: ["inventory_item_id"], forbidden: ["shop_domain", "customer", "data_request"] },
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
 * S3 §C — the top-level product id from a `products/*` webhook body as a BARE DECIMAL STRING, or
 * `undefined`. Shopify's product webhooks carry `"id": <number>` (e.g. `788032119674292922`). Same
 * numeric discipline as `customerIdOf`: a non-negative safe integer or an all-digits string only —
 * everything else refuses, so a hostile value can never be interpolated into a corpus record id or a
 * Storefront GID. `matchesPayloadShape` has already required `id` present for these topics; this
 * validates it.
 */
export function productIdOf(body: Record<string, unknown>): string | undefined {
  const id = body.id;
  if (typeof id === "number") return Number.isSafeInteger(id) && id >= 0 ? String(id) : undefined;
  if (typeof id === "string" && /^\d+$/.test(id)) return id;
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
