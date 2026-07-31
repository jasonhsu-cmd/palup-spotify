import type { IdentityPort, Principal } from "./identity-port.js";
import { b64url, b64urlDecode, hmacSign, constantTimeEqual } from "./token-codec.js";

// Widget tenant-identity adapter (ADR-0011 storefront surface / IAM §8): a short-TTL, PalUp-signed
// token that binds a request to a merchant. The token is minted server-side (the /widget/token step,
// after a valid publishable embed key) and verified on /chat; the tenant is derived from the VERIFIED
// claims — never from any client-supplied value (the core tenancy invariant). HMAC-SHA256 with a
// PalUp-held secret; no external JWT lib (node:crypto only, portable). Slice-2 adapter behind the
// same IdentityPort as the operator token; the Shopify App-Proxy shopper adapter (ADR-0017) is a
// separate, later adapter behind the same port.
//
// ADR-0017 F1 (token-type separation): the token carries a mandatory `typ:"widget"` claim, and
// `authenticate` REJECTS any token whose `typ !== "widget"` — otherwise a shopper session token (which
// also carries a tenant, embedded in its `shopperId` prefix) fed to THIS verifier could be keyed off a
// shopper-controlled `m`-shaped field and yield an escalated `merchant` principal. The shopper adapter
// (shopper-token-identity.ts) enforces the mirror-image check (`typ !== "shopper"` ⇒ anonymous).

/** Mint a signed widget token bound to `merchantId`, valid for `ttlSeconds`. */
export function mintWidgetToken(secret: string, merchantId: string, ttlSeconds: number, nowSec = Math.floor(Date.now() / 1000)): string {
  const body = b64url(Buffer.from(JSON.stringify({ typ: "widget", m: merchantId, exp: nowSec + ttlSeconds })));
  return `${body}.${hmacSign(secret, body)}`;
}

/** Identity adapter that verifies widget tokens → a merchant Principal (anonymous if absent/invalid). */
export function createWidgetTokenIdentity(secret: string | undefined, nowSec = () => Math.floor(Date.now() / 1000)): IdentityPort {
  return {
    async authenticate(credential): Promise<Principal> {
      if (!secret || !credential) return { kind: "anonymous" };
      const dot = credential.indexOf(".");
      if (dot <= 0) return { kind: "anonymous" };
      const body = credential.slice(0, dot);
      const sig = credential.slice(dot + 1);
      const expected = hmacSign(secret, body);
      // constant-time signature compare (length-guarded)
      if (!constantTimeEqual(sig, expected)) return { kind: "anonymous" };
      try {
        const payload = JSON.parse(b64urlDecode(body).toString("utf8")) as {
          typ?: unknown;
          m?: unknown;
          exp?: unknown;
        };
        // F1 — token-type separation: a shopper token (typ:"shopper") must NEVER verify as a merchant.
        if (payload.typ !== "widget") return { kind: "anonymous" };
        if (typeof payload.m !== "string" || !payload.m || typeof payload.exp !== "number" || payload.exp <= nowSec()) {
          return { kind: "anonymous" }; // empty merchantId would become an empty tenant → reject
        }
        return { kind: "merchant", merchantId: payload.m };
      } catch {
        return { kind: "anonymous" };
      }
    },
    authorize(principal, action): boolean {
      // Default-deny: an authenticated merchant may perform shopper/widget actions for its own tenant.
      return principal.kind === "merchant" && (action.startsWith("shopper:") || action.startsWith("widget:"));
    },
  };
}
