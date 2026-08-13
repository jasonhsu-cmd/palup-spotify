import { createHmac, timingSafeEqual } from "node:crypto";

// C1 — Shopify APP-INSTALL (authorization code grant) wire-format adapter. Lives here, next to
// shopify-grounding.ts / shopify-shopper-identity.ts / shopify-customer-account-identity.ts, for the same
// reason they do: it is a NAMED, Shopify-specific ADAPTER behind portable feature code — `node:crypto` and
// a plain injected `fetch`, NO Shopify SDK (ADR-0001, CLAUDE.md §3.3). No Shopify type crosses a port: the
// only things this module hands upward are plain strings and string arrays.
//
// ****************************************************************************************************
// PRIMARY SOURCES. Every wire-format detail below is quoted from one of these; nothing here is written
// from memory. All retrieved 2026-08-05.
//
// [S1] shopify.dev — "Implement authorization code grant manually"
//      https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
//   • Install request: "your app receives a GET request to the App URL path… The request includes the
//     `shop`, `timestamp`, and `hmac` query parameters. You need to verify the authenticity of these
//     requests using the provided `hmac` parameter."
//   • HMAC procedure: "remove the `hmac` parameter from the query string and process it through an
//     HMAC-SHA256 hash function… The remaining parameters must be sorted alphabetically as strings, in the
//     format `parameter_name=parameter_value`." Keyed by "your client secret"; "The message is authentic if
//     the generated hexdigest is equal to the value of the `hmac` parameter", compared with a
//     secure/constant-time comparison (the doc's Ruby sample uses `secure_compare`).
//     Explicitly NOT the webhook procedure ("The HMAC verification procedure for authorization code grant
//     is different from the procedure for verifying webhooks").
//   • Authorize URL:
//     `https://{shop}/admin/oauth/authorize?client_id={client_id}&scope={scopes}&redirect_uri={redirect_uri}&state={nonce}&grant_options[]={access_mode}`
//     — `{scopes}` is "A comma-separated list of scopes"; `{nonce}` is "A randomly selected value provided
//     by your app that is unique for each authorization request. During the OAuth callback, your app must
//     check that this value matches the one you provided during authorization"; `{access_mode}`: "For an
//     online access token, set to `per-user`. For an offline access token, omit this parameter."
//   • Callback shape: `?code={authorization_code}&hmac=…&host={base64_encoded_hostname}&shop={shop_origin}
//     &state={nonce}&timestamp=…`
//   • Required callback security checks, verbatim: the nonce matches the one provided AND "the signed
//     cookie that you set when asking for permission is present and its value equals the nonce value in
//     the state parameter"; "The `hmac` is valid and signed by Shopify"; "The `shop` parameter is a valid
//     shop hostname, ends with `myshopify.com`, and doesn't contain characters other than letters (a-z),
//     numbers (0-9), periods, and hyphens", with the doc's own regex `/^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com/`.
//     "If any of the checks fail, then your app must reject the request with an error and not continue."
//   • Token exchange: `POST https://{shop}.myshopify.com/admin/oauth/access_token`, body
//     `client_id` (required), `client_secret` (required), `code` (required), optional `expiring`
//     ("0 (default) for requesting an offline token that does not have an expiry"). The doc's own curl
//     sample sends `Content-Type: application/x-www-form-urlencoded` and `Accept: application/json`.
//     Non-expiring offline response: `{ "access_token": …, "scope": "write_orders,read_customers" }`.
//   • "Confirm the requested scopes": "it's possible for an app user to change the requested scope in the
//     URL during the authorize phase, so the app should ensure that all required scopes are granted before
//     using the access token."
//
// [S2] shopify.dev — "Use delegate tokens"
//      https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/use-delegate-tokens
//   • "A delegate access token is an OAuth access token with a subset of the total permissions of an app…
//     The parent access token is used to authenticate your request for a delegate access token."
//   • Expiry: "You can explicitly declare an `expiresIn` value… If you don't specify an expiry, then the
//     token expires at the same time as its parent." Field table: "`expiresIn` No — The amount of time, in
//     seconds, after which the delegate access token is no longer valid. If the parent access token is set
//     to expire, then `expiresIn` must be set to a time before the parent token expires. With no
//     `expiresIn` provided, the token expires at the same time as the token that's used to create the
//     delegate."
//   • Scope limits: "An app can delegate only the same or fewer scopes than were granted to it… You can't
//     request extra scopes using the GraphQL Admin APIs. If a new scope is required, then the app must
//     first be re-authorized with the new access scope by a user of the store."; "When an app is
//     re-authorized with fewer access scopes, all delegate access tokens lose the access scopes that are no
//     longer authorized."; "A delegate access token can't be used to create new delegate access tokens."
//   • Endpoint: `POST https://{shop}.myshopify.com/admin/api/{api_version}/graphql.json`; Storefront use is
//     via the `Shopify-Storefront-Private-Token` header (which is exactly what shopify-grounding.ts:13-14
//     already sends), and "private access tokens should be treated as secret and not used on the
//     client-side. We recommend only requesting the scopes that your app needs".
//
// [S3] shopify.dev — `delegateAccessTokenCreate` mutation, GraphQL Admin API **2026-07** (the version
//      picker on that page marks 2026-07 "latest")
//      https://shopify.dev/docs/api/admin-graphql/latest/mutations/delegateAccessTokenCreate
//      `mutation delegateAccessTokenCreate($input: DelegateAccessTokenInput!)`;
//      `input DelegateAccessTokenInput { delegateAccessScope: [String!]!  expiresIn: Int }`;
//      payload `{ delegateAccessToken (DelegateAccessToken), shop (Shop!), userErrors ([…]!) }`.
// [S4] shopify.dev — `DelegateAccessToken` object (same version):
//      https://shopify.dev/docs/api/admin-graphql/latest/objects/DelegateAccessToken
//      fields `accessScopes ([String!]!)`, `accessToken (String!)`, `createdAt (DateTime!)`, `expiresIn (Int)`.
// [S5] shopify.dev — "Shopify API access scopes" https://shopify.dev/docs/api/usage/access-scopes
//      `unauthenticated_read_product_listings` — "Product and Collection objects" (the unauthenticated /
//      Storefront scope family). This is the ONE scope the grounding adapter's catalog read needs.
// [S6] Shopify's OWN validator (Shopify-authored source, the only place the exact byte-level message
//      construction is pinned down — [S1] does not disambiguate percent-encoding):
//      https://raw.githubusercontent.com/Shopify/shopify-app-js/main/packages/apps/shopify-api/lib/utils/hmac-validator.ts
//      https://raw.githubusercontent.com/Shopify/shopify-app-js/main/packages/apps/shopify-api/lib/utils/processed-query.ts
//   • `const {hmac: _hmac, signature: _signature, ...query} = params;` — BOTH `hmac` and `signature` are
//     stripped before hashing (the prose in [S1] mentions only `hmac`).
//   • admin form: keys sorted with `localeCompare`, appended to a `URLSearchParams`, then
//     `stringify(true)` = `this.processedQuery.toString().replace(/\+/g, '%20')` — so the message is
//     percent-encoded x-www-form-urlencoded with `+` rendered as `%20`.
//   • repeated keys are normalised to a single comma-joined value (`${existingValue},${value}`).
//   • `HMAC_TIMESTAMP_PERMITTED_CLOCK_TOLERANCE_SEC = 90`, enforced as
//     `Math.abs(getCurrentTimeInSec() - Number(query.timestamp)) > 90` ⇒ invalid.
//
// WHAT IS *NOT* VERIFIED, stated rather than implied:
//   • NO GOLDEN VECTOR. `shopify-install-identity.test.ts` checks our signer against an independent
//     transcription of [S1]+[S6]; both sides share one reading of the spec, so this proves internal
//     consistency, NOT byte-equality with Shopify's live output. A real (secret, query, hmac) triple
//     captured from an actual install is still required before go-live — the same caveat
//     shopify-shopper-identity.ts:18-22 records for App-Proxy signatures.
//   • NO LIVE CALL. Neither `/admin/oauth/access_token` nor `delegateAccessTokenCreate` has been exercised
//     against a real store from this repo. Everything here is fixture-tested against an injected `fetch`.
//   • The Storefront scope required for `shop.refundPolicy` / `shop.shippingPolicy` (which
//     shopify-grounding.ts reads) is NOT documented on either [S5] or the Storefront `Shop` object page —
//     neither annotates those fields with an `unauthenticated_*` scope. So `DELEGATE_SCOPES_DEFAULT` claims
//     only what [S5] does state (`unauthenticated_read_product_listings`, for products), and the scope list
//     is operator-overridable via env. An operator who needs policy text must add the scope deliberately;
//     this module will not guess one into a credential.
// ****************************************************************************************************

/**
 * The app's OAuth client secret is APP-SCOPED, not per-merchant: one secret signs every merchant's install
 * HMAC and authenticates every token exchange. So it uses the same reserved sentinel "tenant" the
 * app-proxy shared secret does (shopify-shopper-identity.ts:36) rather than pretending to be tenant-scoped.
 * Its compromise forges install callbacks for EVERY merchant — rotate it, never log it, never echo it.
 */
export const SHOPIFY_APP_SECRET_SCOPE = "__shopify_app__";
export const SHOPIFY_APP_CLIENT_SECRET_NAME = "shopify_app_client_secret";

/** Admin API version pinned for the delegate mutation ([S3]). Matches the Storefront version already
 *  pinned at shopify-grounding.ts:96, so both Shopify surfaces move together. */
export const ADMIN_API_VERSION = "2026-07";

/** Least privilege ([S2]: "only requesting the scopes that your app needs"); see [S5] and the NOT-VERIFIED
 *  note above for why this is exactly one scope. */
export const DELEGATE_SCOPES_DEFAULT: readonly string[] = ["unauthenticated_read_product_listings"];

/** Shopify's own tolerance, both directions ([S6]). Anti-replay for a captured, validly-signed URL. */
export const OAUTH_TIMESTAMP_TOLERANCE_SECONDS = 90;

/**
 * The `*.myshopify.com` allowlist. BYTE-IDENTICAL to the pattern shopify-grounding.ts:102 already uses, on
 * purpose — one host rule for every Shopify egress in this package, so a host that the grounding fetch
 * would refuse can never be installed here (and vice versa). It is STRICTER than [S1]'s own suggested
 * regex in two ways that matter for an attacker-supplied value:
 *   • `$`-anchored, so `acme.myshopify.com.evil.test` and `acme.myshopify.com/admin` are refused. [S1]'s
 *     regex has no end anchor; used literally it would accept both.
 *   • no `.` inside the label, so exactly ONE label precedes `.myshopify.com`. [S1]'s prose allows periods
 *     among the legal characters, which would admit `evil.acme.myshopify.com`.
 * A trailing DNS root dot (`acme.myshopify.com.`) is refused rather than stripped — B1 reported that
 * `pl_merchant` treats it as a DISTINCT key (postgres-merchant-registry.ts:104-111), so accepting it here
 * would be the input side of that same two-tenants-one-store hazard. Refusing surprising input is the rule
 * (never normalise it into something acceptable).
 */
const SHOP_HOST = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

/** True only for a plain, exact `<label>.myshopify.com` string. Never throws; every other value is false. */
export function isValidShopDomain(value: unknown): boolean {
  return typeof value === "string" && SHOP_HOST.test(value);
}

/** A parsed query: Fastify hands back a string for a single key and a string[] for a repeated one. */
export type OauthQuery = Record<string, string | string[] | undefined>;

/**
 * Narrow a raw parsed query to the values that can participate in a signature. Keeps strings and
 * all-string arrays (a repeated key is legitimately signed comma-joined — [S6]) and DROPS everything else
 * as untrusted. Null-prototype output so an attacker-chosen parameter name (`__proto__`, `constructor`)
 * cannot resolve or install an inherited value. Same shape and same reasoning as
 * `normalizeAppProxyQuery` (shopify-shopper-identity.ts:69).
 */
export function normalizeOauthQuery(rawQuery: Record<string, unknown>): OauthQuery {
  const params: OauthQuery = Object.create(null);
  for (const [k, v] of Object.entries(rawQuery)) {
    if (typeof v === "string") params[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === "string")) params[k] = v as string[];
  }
  return params;
}

/**
 * The documented admin/OAuth HMAC message, exactly as [S1] describes it and [S6] pins it byte-for-byte:
 * drop `hmac` and `signature`, sort the remaining keys with `localeCompare`, render through
 * `URLSearchParams` (percent-encoded) with `+` rewritten to `%20`, HMAC-SHA256 with the app client secret,
 * hex. Exported so tests can mint validly-signed queries with the SAME routine — no mint/verify drift.
 *
 * `localeCompare` (not the default codepoint sort) is deliberate parity with [S6]. Every documented
 * callback parameter name is lowercase ASCII, where the two orders coincide; an exotic attacker-added name
 * that sorted differently would simply fail verification, which is the correct outcome.
 */
export function signOauthQuery(secret: string, params: OauthQuery): string {
  const sp = new URLSearchParams();
  for (const key of Object.keys(params)
    .filter((k) => k !== "hmac" && k !== "signature" && params[k] !== undefined)
    .sort((a, b) => a.localeCompare(b))) {
    const v = params[key];
    sp.append(key, Array.isArray(v) ? v.join(",") : (v as string));
  }
  return createHmac("sha256", secret).update(sp.toString().replace(/\+/g, "%20")).digest("hex");
}

/**
 * Constant-time verification of the `hmac` parameter ([S1]: reject if it does not match; the doc's sample
 * uses a secure comparison). Returns a boolean and NEVER throws — a malformed digest is an unauthenticated
 * request, not an exception, and an exception here would be an easy way to turn the callback into an
 * error-message oracle. A blank/absent secret verifies NOTHING (fail closed): an unconfigured app secret
 * must never accidentally accept a request signed with the empty key.
 */
export function verifyOauthHmac(secret: string, params: OauthQuery): boolean {
  try {
    if (typeof secret !== "string" || !secret) return false;
    const provided = params.hmac;
    if (typeof provided !== "string" || !provided) return false;
    const expected = signOauthQuery(secret, params);
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    // Length is compared first because timingSafeEqual throws on unequal lengths. The length of a hex
    // digest is public (64 chars), so this leaks nothing an attacker does not already know.
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Anti-replay on the `timestamp` parameter, both directions, using Shopify's own ±90s tolerance ([S6]).
 * A missing / non-numeric / array timestamp is REFUSED rather than coerced — `Number(undefined)` is `NaN`
 * and `Number("")` is `0`, and a `0` would look like 1970 and fail the wrong way round in some readings.
 */
export function timestampWithinTolerance(value: unknown, nowSec: number): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  const ts = Number(value);
  if (!Number.isFinite(ts)) return false;
  return Math.abs(nowSec - ts) <= OAUTH_TIMESTAMP_TOLERANCE_SECONDS;
}

export interface AuthorizeUrlArgs {
  shopDomain: string;
  clientId: string;
  redirectUri: string;
  /** Comma-separated, per [S1]. */
  scopes: string;
  /** The single-use CSRF nonce. */
  state: string;
}

/**
 * The grant-screen URL ([S1] Step 2). `grant_options[]` is OMITTED, which [S1] defines as "an offline
 * access token" — the right choice and not an arbitrary one: an ONLINE token is tied to the individual
 * staff member who clicked Install and expires with their session, so it could not back a server-side
 * Storefront read, and its expiry would silently strand grounding on fixtures.
 *
 * THROWS for a non-myshopify host rather than returning a value: this URL is where a merchant's browser
 * gets sent and, downstream, where an app-secret-authenticated POST goes. There is no sensible "best
 * effort" for an unrecognised host (the same posture as shopify-grounding.ts:257).
 */
export function buildInstallAuthorizeUrl(args: AuthorizeUrlArgs): string {
  if (!isValidShopDomain(args.shopDomain))
    throw new Error("refusing to build an install authorize URL: shop is not a *.myshopify.com host");
  const u = new URL(`https://${args.shopDomain}/admin/oauth/authorize`);
  u.searchParams.set("client_id", args.clientId);
  u.searchParams.set("scope", args.scopes);
  u.searchParams.set("redirect_uri", args.redirectUri);
  u.searchParams.set("state", args.state);
  return u.toString();
}

/** What the exchange yields, in portable terms — no Shopify type crosses out of this module. */
export interface InstallGrant {
  /** The PARENT offline access token. SECRET. Used once, in memory, to mint the delegate token. */
  accessToken: string;
  /** The scopes the merchant actually granted, split from the response's comma-separated `scope`. */
  grantedScopes: string[];
}

export interface ExchangeArgs {
  shopDomain: string;
  clientId: string;
  clientSecret: string;
  code: string;
}

/**
 * Exchange the authorization code for a non-expiring OFFLINE access token ([S1] Step 4). `expiring` is not
 * sent, so the default (`0`, "an offline token that does not have an expiry") applies.
 *
 * NEVER THROWS and NEVER returns a partial value: any refusal is `null`. That is not laziness, it is the
 * leak boundary — `code`, `clientSecret` and `access_token` are all arguments or results of this call, and
 * an exception here would carry a stack (and, in the sloppy version, a wrapped upstream message) into a
 * caller that renders errors to an attacker-reachable HTTP response. The caller maps `null` onto a uniform
 * refusal. Nothing in this function logs.
 */
export async function exchangeInstallCode(args: ExchangeArgs, fetchFn: typeof globalThis.fetch): Promise<InstallGrant | null> {
  try {
    // Before any network call: the app secret is about to be POSTed to this host, so an unrecognised host
    // would be a credential exfiltration (the same defence shopify-grounding.ts:257 applies to the
    // Storefront token).
    if (!isValidShopDomain(args.shopDomain)) return null;
    if (!args.clientId || !args.clientSecret || !args.code) return null;
    const body = new URLSearchParams({ client_id: args.clientId, client_secret: args.clientSecret, code: args.code });
    const res = await fetchFn(`https://${args.shopDomain}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { access_token?: unknown; scope?: unknown } | null;
    const accessToken = typeof json?.access_token === "string" ? json.access_token : "";
    if (!accessToken) return null;
    const grantedScopes =
      typeof json?.scope === "string"
        ? json.scope
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
    return { accessToken, grantedScopes };
  } catch {
    return null; // a transport fault is a refusal, never an exception carrying the code/secret upward
  }
}

/**
 * `scope` on the token response is what the merchant ACTUALLY granted, and [S1] warns it can differ from
 * what we asked for ("it's possible for an app user to change the requested scope in the URL"). [S2] then
 * says a delegate token may carry "only the same or fewer scopes than were granted". So: check the
 * intersection ourselves BEFORE spending a mutation, rather than reading a `userErrors` array to find out.
 *
 * [S1]'s read/write rule is honoured — "If you requested both the read and write access scopes for a
 * resource, then check only for the write access scope. The read access scope is omitted because it's
 * implied by the write access scope." — so a required `read_x` is satisfied by a granted `write_x`.
 */
export function grantedScopesCover(required: readonly string[], granted: readonly string[]): boolean {
  const have = new Set(granted);
  return required.every((need) => have.has(need) || (need.startsWith("read_") && have.has(`write_${need.slice(5)}`)));
}

/** The delegate mutation text ([S3]). A module constant, never built from input. */
const DELEGATE_MUTATION = `mutation delegateAccessTokenCreate($input: DelegateAccessTokenInput!) {
  delegateAccessTokenCreate(input: $input) {
    delegateAccessToken { accessToken accessScopes }
    userErrors { field message }
  }
}`;

export interface DelegateTokenArgs {
  shopDomain: string;
  /** The parent offline token from `exchangeInstallCode`. SECRET; used only as a request header. */
  parentAccessToken: string;
  delegateScopes: readonly string[];
}

export interface DelegateToken {
  /** SECRET — a Storefront PRIVATE token ([S2]: "should be treated as secret and not used on the
   *  client-side"). It goes straight into encrypted custody; it is never logged, echoed or audited. */
  accessToken: string;
  /** Non-secret: what the token can actually do, as Shopify reports it ([S4] `accessScopes`). */
  accessScopes: string[];
}

/**
 * Mint a delegate access token from the parent ([S2] Step 1, [S3]).
 *
 * `expiresIn` is deliberately NOT sent. Per [S2] the token then "expires at the same time as its parent",
 * and the parent here is a non-expiring offline token — so the delegate does not silently expire. That
 * matters more than it looks: a credential that quietly stopped working would send grounding back to
 * fixtures with nothing for an operator to point at, which is the exact silent-absence failure B2's
 * `MerchantCredentialRead` union exists to avoid. Rotation is a fresh install/authorise, not an expiry.
 *
 * Same never-throw contract and same reason as `exchangeInstallCode`: the parent token is an argument and
 * the delegate token is the result.
 */
export async function createDelegateAccessToken(
  args: DelegateTokenArgs,
  fetchFn: typeof globalThis.fetch,
): Promise<DelegateToken | null> {
  try {
    if (!isValidShopDomain(args.shopDomain)) return null;
    if (!args.parentAccessToken) return null;
    const scopes = (args.delegateScopes ?? []).filter((s) => typeof s === "string" && s.trim());
    // A delegate token with no scopes authenticates but authorises nothing — it would look like working
    // custody and fail every read. Refuse rather than store one.
    if (scopes.length === 0) return null;
    const res = await fetchFn(`https://${args.shopDomain}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-shopify-access-token": args.parentAccessToken },
      body: JSON.stringify({ query: DELEGATE_MUTATION, variables: { input: { delegateAccessScope: scopes } } }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: { delegateAccessTokenCreate?: { delegateAccessToken?: { accessToken?: unknown; accessScopes?: unknown } | null; userErrors?: unknown[] } };
      errors?: unknown[];
    } | null;
    // A GraphQL 200 can still be a failure two different ways: a top-level `errors` array (request-level)
    // and a populated `userErrors` (mutation-level). Both are refusals.
    if (Array.isArray(json?.errors) && json.errors.length > 0) return null;
    const payload = json?.data?.delegateAccessTokenCreate;
    if (!payload) return null;
    if (Array.isArray(payload.userErrors) && payload.userErrors.length > 0) return null;
    const accessToken = typeof payload.delegateAccessToken?.accessToken === "string" ? payload.delegateAccessToken.accessToken : "";
    if (!accessToken) return null;
    const accessScopes = Array.isArray(payload.delegateAccessToken?.accessScopes)
      ? (payload.delegateAccessToken.accessScopes as unknown[]).filter((s): s is string => typeof s === "string")
      : [];
    return { accessToken, accessScopes };
  } catch {
    return null;
  }
}

// ── Shop-specific webhook registration (legacy install flow) ─────────────────────────────────────────
//
// The linked app config sets `use_legacy_install_flow = true`, which is INCOMPATIBLE with declarative
// `[webhooks]` subscriptions ([S1]/the app TOML). Under that flow, webhooks must be registered
// SHOP-SPECIFICALLY via the Admin API during install. The `/shopify/webhooks/*` handler routes already
// exist (routes/shopify-webhooks.ts); this is the missing producer that subscribes Shopify to them.
//
// [S7] shopify.dev — `webhookSubscriptionCreate` mutation, GraphQL Admin API **2026-07** (same version
//      picker "latest" as [S3]). VERIFIED on 2026-08-14: the input field is `uri` (NOT the deprecated
//      `callbackUrl`), and `format` is a `WebhookSubscriptionFormat` enum whose value here is `JSON`.
//      https://shopify.dev/docs/api/admin-graphql/latest/mutations/webhookSubscriptionCreate
//   • Signature: `mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!,
//     $webhookSubscription: WebhookSubscriptionInput!)`; payload `{ webhookSubscription, userErrors }`.
//   • Creating a subscription needs no EXTRA scope, but each TOPIC needs its resource read scope
//     (PRODUCTS_* → read_products, INVENTORY_LEVELS_UPDATE → read_inventory, APP_UNINSTALLED → none). The
//     PARENT token holds only what the merchant granted at install, so a topic whose scope was not granted
//     comes back as a `userErrors` failure — which is exactly why this is best-effort (see the call site).

/** One subscription to create: a GraphQL `WebhookSubscriptionTopic` enum name and an absolute https URL on
 *  THIS app host. Both come from OPERATOR CONFIG at the composition root — never from the shop or a
 *  request (SSRF defence): the `uri` decides where Shopify posts, so it must never be attacker-derived. */
export interface WebhookSubscriptionSpec {
  topic: string;
  uri: string;
}

/** The outcome, in closed-set topic names only. NEVER the token, never a raw Shopify `userErrors` message —
 *  those must not enter a log or an immutable audit record (NN#5). Tallies are the whole contract. */
export interface WebhookRegistrationResult {
  registered: string[];
  failed: string[];
}

/** The mutation text ([S7]). A module constant, never built from input. The input field is `uri`, not the
 *  deprecated `callbackUrl`. */
const WEBHOOK_SUBSCRIPTION_CREATE_MUTATION = `mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
    webhookSubscription { id }
    userErrors { field message }
  }
}`;

/**
 * Register each webhook subscription against the shop's Admin API, authenticated by the PARENT offline
 * token (the same one used to mint the delegate). Mirrors `createDelegateAccessToken`:
 *   • host RE-VALIDATED before any fetch — the Admin token must never egress to a non-myshopify host, the
 *     same credential-exfiltration defence the other identity fns apply;
 *   • NEVER throws — a per-topic transport fault, a non-2xx, a top-level `errors` array or a non-empty
 *     `userErrors` is a `failed` tally, not an exception;
 *   • leaks NOTHING upward — only closed-set topic names, never the token or the raw `userErrors` text.
 *
 * Returns WITHOUT any fetch (empty tallies) when the host is invalid, the token is empty, or there are no
 * subscriptions — so an unconfigured or back-compat caller makes zero outbound calls.
 */
export async function registerWebhookSubscriptions(
  args: { shopDomain: string; parentAccessToken: string; subscriptions: readonly WebhookSubscriptionSpec[] },
  fetchFn: typeof fetch = fetch,
): Promise<WebhookRegistrationResult> {
  const registered: string[] = [];
  const failed: string[] = [];
  // Same leak boundary as the other identity fns: no fetch at all for a host we do not recognise, an empty
  // token, or nothing to do. The Admin token would otherwise be POSTed to whatever host was supplied.
  if (!isValidShopDomain(args.shopDomain)) return { registered, failed };
  if (!args.parentAccessToken) return { registered, failed };
  const subscriptions = args.subscriptions ?? [];
  if (subscriptions.length === 0) return { registered, failed };

  const endpoint = `https://${args.shopDomain}/admin/api/${ADMIN_API_VERSION}/graphql.json`;
  for (const sub of subscriptions) {
    try {
      const res = await fetchFn(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "x-shopify-access-token": args.parentAccessToken },
        body: JSON.stringify({
          query: WEBHOOK_SUBSCRIPTION_CREATE_MUTATION,
          variables: { topic: sub.topic, webhookSubscription: { uri: sub.uri, format: "JSON" } },
        }),
      });
      if (!res.ok) {
        failed.push(sub.topic);
        continue;
      }
      const json = (await res.json()) as {
        data?: { webhookSubscriptionCreate?: { webhookSubscription?: { id?: unknown } | null; userErrors?: unknown[] } };
        errors?: unknown[];
      } | null;
      // A GraphQL 200 can still be a failure two ways: a top-level `errors` array (request-level) or a
      // populated `userErrors` (mutation-level — e.g. a topic whose read scope was not granted). Both fail.
      if (Array.isArray(json?.errors) && json.errors.length > 0) {
        failed.push(sub.topic);
        continue;
      }
      const payload = json?.data?.webhookSubscriptionCreate;
      if (payload && Array.isArray(payload.userErrors) && payload.userErrors.length > 0) {
        failed.push(sub.topic);
        continue;
      }
      registered.push(sub.topic);
    } catch {
      // A per-topic transport fault is a `failed` tally, never an exception carrying the parent token or a
      // stack upward — one topic failing must not abandon the rest.
      failed.push(sub.topic);
    }
  }
  return { registered, failed };
}
