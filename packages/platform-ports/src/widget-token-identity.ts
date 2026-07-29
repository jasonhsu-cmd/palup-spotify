import { createHmac, timingSafeEqual } from "node:crypto";
import type { IdentityPort, Principal } from "./identity-port.js";

// Widget tenant-identity adapter (ADR-0011 storefront surface / IAM §8): a short-TTL, PalUp-signed
// token that binds a request to a merchant. The token is minted server-side (the /widget/token step,
// after a valid publishable embed key) and verified on /chat; the tenant is derived from the VERIFIED
// claims — never from any client-supplied value (the core tenancy invariant). HMAC-SHA256 with a
// PalUp-held secret; no external JWT lib (node:crypto only, portable). Slice-2 adapter behind the
// same IdentityPort as the operator token; Shopify App-Proxy verification can be a later adapter.

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function sign(secret: string, body: string): string {
  return b64url(createHmac("sha256", secret).update(body).digest());
}

/** Mint a signed widget token bound to `merchantId`, valid for `ttlSeconds`. */
export function mintWidgetToken(secret: string, merchantId: string, ttlSeconds: number, nowSec = Math.floor(Date.now() / 1000)): string {
  const body = b64url(Buffer.from(JSON.stringify({ m: merchantId, exp: nowSec + ttlSeconds })));
  return `${body}.${sign(secret, body)}`;
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
      const expected = sign(secret, body);
      // constant-time signature compare (length-guarded)
      const a = Buffer.from(sig);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return { kind: "anonymous" };
      try {
        const payload = JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as {
          m?: unknown;
          exp?: unknown;
        };
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
