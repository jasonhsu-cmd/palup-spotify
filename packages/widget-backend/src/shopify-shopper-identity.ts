import { createHmac, timingSafeEqual } from "node:crypto";
import type { Principal, SecretsPort } from "@palup/platform-ports";
import { buildShopifyShopperId } from "@palup/platform-ports";

// Shopify App-Proxy shopper identity adapter (ADR-0017 §2 — T2). Lives here (not @palup/platform-ports)
// for the same reason shopify-grounding.ts does: it is a NAMED, Shopify-specific ADAPTER behind the
// portable IdentityPort/Principal (identity-port.ts), composed at the widget-backend root — never a
// vendor SDK, node:crypto only (ADR-0001).
//
// ****************************************************************************************************
// HONESTY / SPIKE GATE (T2b, ADR-0017 "Shopify mechanism — honesty calibration"): the EXACT wire format
// below — which params Shopify signs, whether `logged_in_customer_id` is INSIDE the signed set (the
// linchpin, F3 — if it is NOT signed, this whole adapter is forgeable from any validly-signed proxy
// URL), and the precise signature algorithm (sort+concatenate, hex vs base64, etc.) — is UNVERIFIED
// this session (recollection only; could not be re-confirmed from shopify.dev this session). This file
// implements a SELF-CONSISTENT stub: it signs/verifies with the SAME routine (`signAppProxyParams`), so
// every security invariant below (signature integrity, replay, cross-shop, namespace validation) is
// deterministically testable NOW, independent of whether the stub's concatenation matches Shopify's
// real one. The live cutover (pointing this at real App-Proxy traffic) stays BLOCKED until T2b confirms
// (a) in particular — do not remove this comment when T2b lands; replace it with the citation instead.
// ****************************************************************************************************

/** App-scoped shared secret (F8: ONE secret for the whole app, NOT per-tenant — its compromise forges
 * shopper identity for every merchant, a higher blast radius than the per-tenant Storefront token, so:
 * rotation + access-logging, never env-in-repo/logs). Reserved sentinel "tenant" scope for the
 * SecretsPort (mirrors the `"__mint__"` rate-limit sentinel in server.ts) since SecretsPort is
 * tenant-scoped by shape but this secret is deliberately NOT tenant-scoped. */
export const SHOPIFY_APP_PROXY_SECRET_SCOPE = "__shopify_app__";
export const SHOPIFY_APP_PROXY_SECRET_NAME = "shopify_app_proxy_secret";

export type AppProxyParams = Record<string, string | undefined>;

/**
 * Sign the App-Proxy params: sort keys lexicographically, concatenate `key=value` with no separator,
 * HMAC-SHA256 keyed by the app shared secret, hex digest (STUB routine — see the honesty note above).
 * `signature` (if present in `params`) is excluded — it is what we are computing, not what we sign over.
 * Exported so tests can mint validly-signed params with the SAME routine (no drift between mint/verify).
 */
export function signAppProxyParams(secret: string, params: AppProxyParams): string {
  const keys = Object.keys(params)
    .filter((k) => k !== "signature" && params[k] !== undefined)
    .sort();
  const concatenated = keys.map((k) => `${k}=${params[k]}`).join("");
  return createHmac("sha256", secret).update(concatenated).digest("hex");
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
