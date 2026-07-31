import { createHmac, timingSafeEqual } from "node:crypto";
import type { Principal, SecretsPort } from "@palup/platform-ports";
import { buildShopifyShopperId } from "@palup/platform-ports";

// Shopify App-Proxy shopper identity adapter (ADR-0017 §2 — T2). Lives here (not @palup/platform-ports)
// for the same reason shopify-grounding.ts does: it is a NAMED, Shopify-specific ADAPTER behind the
// portable IdentityPort/Principal (identity-port.ts), composed at the widget-backend root — never a
// vendor SDK, node:crypto only (ADR-0001).
//
// ****************************************************************************************************
// WIRE FORMAT (ADR-0017 T2b) — VERIFIED against shopify.dev "Authenticate app proxies"
// (https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies, retrieved
// 2026-08-01): drop the `signature` param; render each remaining param as `key=value` with any repeated
// (multi-value) key joined by ','; sort the pairs lexicographically; concatenate with NO delimiter
// (unlike OAuth's '&'); HMAC-SHA256 keyed by the app's shared secret; hex; constant-time compare.
// CRUCIALLY, `logged_in_customer_id` IS one of the signed params per the doc (F3 linchpin — the shopper
// id cannot be forged from a proxy URL validly signed for a DIFFERENT customer). `signAppProxyParams`
// below implements exactly this. `shopify-shopper-identity.test.ts` checks it against a from-the-spec
// transcription of the SAME algorithm — that catches drift between our signer and the documented steps,
// but it is NOT independent proof that our bytes match Shopify's LIVE output (both sides share the one
// transcription). TRUE conformance needs a GOLDEN VECTOR — a real (secret, params, signature) triple
// captured from actual App-Proxy traffic — captured at the live-cutover smoke below.
//
// LIVE CUTOVER is now an OPERATIONAL go-live (no longer a format question): provision the app-proxy
// shared secret — the custom app's API secret, from a custom app that has an App Proxy configured; the
// Headless channel does NOT provide one — into the SecretsPort under SHOPIFY_APP_PROXY_SECRET_*, flip
// SHOPPER_AUTH on (F4 also needs WIDGET_AUTH_REQUIRED), then a live smoke against real App-Proxy traffic
// + a security re-review.
// ****************************************************************************************************

/** App-scoped shared secret (F8: ONE secret for the whole app, NOT per-tenant — its compromise forges
 * shopper identity for every merchant, a higher blast radius than the per-tenant Storefront token, so:
 * rotation + access-logging, never env-in-repo/logs). Reserved sentinel "tenant" scope for the
 * SecretsPort (mirrors the `"__mint__"` rate-limit sentinel in server.ts) since SecretsPort is
 * tenant-scoped by shape but this secret is deliberately NOT tenant-scoped. */
export const SHOPIFY_APP_PROXY_SECRET_SCOPE = "__shopify_app__";
export const SHOPIFY_APP_PROXY_SECRET_NAME = "shopify_app_proxy_secret";

// A repeated query key parses to a string[]; Shopify signs it comma-joined (see WIRE FORMAT above).
export type AppProxyParams = Record<string, string | string[] | undefined>;

/**
 * Sign the App-Proxy params per the verified Shopify format (see the WIRE FORMAT note above): drop
 * `signature`, render each param as `key=value` with any multi-value (repeated) key joined by ',', sort
 * lexicographically, concatenate with no separator, HMAC-SHA256 keyed by the app shared secret, hex.
 * Exported so tests can mint validly-signed params with the SAME routine (no drift between mint/verify).
 */
export function signAppProxyParams(secret: string, params: AppProxyParams): string {
  const keys = Object.keys(params)
    .filter((k) => k !== "signature" && params[k] !== undefined)
    .sort();
  const concatenated = keys
    .map((k) => {
      const v = params[k];
      return `${k}=${Array.isArray(v) ? v.join(",") : v}`;
    })
    .join("");
  return createHmac("sha256", secret).update(concatenated).digest("hex");
}

/**
 * Normalize a raw parsed query (`req.query`) into `AppProxyParams` for verification. Keeps string values
 * and repeated-key **string arrays** — Shopify signs repeated params comma-joined, so dropping them would
 * make a legitimately-signed request fail-closed to anonymous — and drops any other value (numbers,
 * objects, mixed arrays) as untrusted. Null-proto output so an attacker-controlled key (`__proto__`,
 * `constructor`) can't pollute. The verifier's semantic fields (`shop`/`timestamp`/`logged_in_customer_id`)
 * still reject array values via their own `typeof` guards — this only preserves them for the signature.
 */
export function normalizeAppProxyQuery(rawQuery: Record<string, unknown>): AppProxyParams {
  const params: AppProxyParams = Object.create(null);
  for (const [k, v] of Object.entries(rawQuery)) {
    if (typeof v === "string") params[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === "string")) params[k] = v as string[];
  }
  return params;
}

export interface ShopifyShopperVerifyOptions {
  /** The widget-token-VERIFIED tenant this session is bound to. `shop` must resolve to THIS tenant
   * (step 5, cross-shop check) — mismatch ⇒ anonymous. */
  expectedTenant: string;
  /** Resolve a raw `shop` domain (e.g. "acme.myshopify.com") to its PalUp tenant id, or undefined. */
  resolveTenant: (shopDomain: string) => string | undefined;
  /** The SecretsPort to fetch the app-scoped shared secret from (F8). */
  secrets: SecretsPort;
  /** Anti-replay max age in seconds (F5). Default 300s (a few minutes). */
  maxAgeSeconds?: number;
  /** Anti-replay future-skew tolerance in seconds (F5 — reject FUTURE timestamps beyond this). Default 60s. */
  futureSkewSeconds?: number;
  /** Injectable clock for tests. */
  nowSec?: () => number;
}

/**
 * Verify a Shopify App-Proxy request's shopper credential → a Principal. NEVER throws — any failure
 * (bad/missing signature, empty/absent `logged_in_customer_id`, stale/future timestamp, cross-shop
 * mismatch, malformed namespace components) degrades to `{kind:"anonymous"}` (fail-closed, ADR-0017 §2).
 */
export async function verifyShopifyAppProxyShopper(
  params: AppProxyParams,
  opts: ShopifyShopperVerifyOptions,
): Promise<Principal> {
  try {
    const signature = params.signature;
    if (typeof signature !== "string" || !signature) return { kind: "anonymous" };

    const secret = await opts.secrets.get(SHOPIFY_APP_PROXY_SECRET_SCOPE, SHOPIFY_APP_PROXY_SECRET_NAME);
    if (!secret) return { kind: "anonymous" };

    const expected = signAppProxyParams(secret, params);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { kind: "anonymous" }; // tampered/wrong sig

    // Empty/absent logged_in_customer_id ⇒ the shopper is browsing, not logged in ⇒ anonymous.
    const cid = params.logged_in_customer_id;
    if (typeof cid !== "string" || cid.length === 0) return { kind: "anonymous" };

    // F5 — anti-replay: reject a stale timestamp AND reject a FUTURE one (clock-skew tolerance both ways).
    const rawTs = params.timestamp;
    const ts = typeof rawTs === "string" ? Number(rawTs) : NaN;
    if (!Number.isFinite(ts)) return { kind: "anonymous" };
    const now = (opts.nowSec ?? (() => Math.floor(Date.now() / 1000)))();
    const maxAge = opts.maxAgeSeconds ?? 300;
    const futureSkew = opts.futureSkewSeconds ?? 60;
    if (now - ts > maxAge) return { kind: "anonymous" }; // stale
    if (ts - now > futureSkew) return { kind: "anonymous" }; // future

    // Cross-shop check: shop -> tenant MUST equal the already-verified widget-token tenant.
    const shop = params.shop;
    if (typeof shop !== "string" || !shop) return { kind: "anonymous" };
    const tenant = opts.resolveTenant(shop);
    if (!tenant || tenant !== opts.expectedTenant) return { kind: "anonymous" };

    // F6 — namespace validation (construction-time collision-safety).
    const shopperId = buildShopifyShopperId(tenant, cid);
    if (!shopperId) return { kind: "anonymous" };

    return { kind: "shopper", shopperId, source: "shopify", verified: true };
  } catch {
    return { kind: "anonymous" }; // never throw — an unauthenticated shopper is anonymous, not an error
  }
}
