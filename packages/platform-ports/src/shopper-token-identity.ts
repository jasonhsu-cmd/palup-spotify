import type { IdentityPort, Principal } from "./identity-port.js";
import { authorize } from "./identity-port.js";
import { b64url, b64urlDecode, hmacSign, constantTimeEqual } from "./token-codec.js";

// Shopper session-token transport adapter (ADR-0017 §2 "Transport"): a short-TTL, PalUp-signed token
// carrying a VERIFIED shopper identity, minted once at `/shopper/session` (after the Shopify App-Proxy
// verification in shopify-shopper-identity.ts succeeds) and sent by the widget on `/chat` alongside the
// merchant widget token. Mirrors widget-token-identity.ts's mint/verify pattern exactly (same HMAC-SHA256
// + base64url codec, node:crypto only) — the ONLY structural difference is the mandatory `typ:"shopper"`
// claim (ADR-0017 F1), which is what keeps the two token types from being confused for one another.
//
// F1 (token-type separation): `authenticate` REJECTS any token whose `typ !== "shopper"` — so a widget/
// merchant token (typ:"widget") fed to THIS verifier can never yield a shopper principal (and, by the
// mirror-image check in widget-token-identity.ts, a shopper token can never yield a merchant principal
// either). Domain-separate keys per token type would be an equally valid alternative to the `typ` claim;
// we use `typ` because it keeps a single secret/codec to provision and test.

/**
 * Mint a shopper session token. `shopperId` + `source` MUST already be server-verified (the caller runs
 * the T2 Shopify App-Proxy verification exactly once, at `/shopper/session`) — this function itself does
 * no verification, it only signs whatever it is given, exactly like `mintWidgetToken`.
 */
export function mintShopperToken(
  secret: string,
  shopperId: string,
  source: "shopify" | "otp",
  ttlSeconds: number,
  nowSec = Math.floor(Date.now() / 1000),
): string {
  const body = b64url(Buffer.from(JSON.stringify({ typ: "shopper", sid: shopperId, src: source, exp: nowSec + ttlSeconds })));
  return `${body}.${hmacSign(secret, body)}`;
}

/** Identity adapter that verifies shopper session tokens → a shopper Principal. Anonymous on ANY
 * failure (absent/unconfigured secret, tampered signature, wrong `typ`, malformed/empty claims, or
 * expiry) — NEVER throws, mirroring every other adapter's `authenticate` contract. */
export function createShopperTokenIdentity(secret: string | undefined, nowSec = () => Math.floor(Date.now() / 1000)): IdentityPort {
  return {
    async authenticate(credential): Promise<Principal> {
      if (!secret || !credential) return { kind: "anonymous" };
      const dot = credential.indexOf(".");
      if (dot <= 0) return { kind: "anonymous" };
      const body = credential.slice(0, dot);
      const sig = credential.slice(dot + 1);
      const expected = hmacSign(secret, body);
      if (!constantTimeEqual(sig, expected)) return { kind: "anonymous" };
      try {
        const payload = JSON.parse(b64urlDecode(body).toString("utf8")) as {
          typ?: unknown;
          sid?: unknown;
          src?: unknown;
          exp?: unknown;
        };
        // F1 — token-type separation: a widget/merchant token (typ:"widget") must NEVER verify here.
        if (payload.typ !== "shopper") return { kind: "anonymous" };
        if (typeof payload.sid !== "string" || !payload.sid) return { kind: "anonymous" };
        if (payload.src !== "shopify" && payload.src !== "otp") return { kind: "anonymous" };
        if (typeof payload.exp !== "number" || payload.exp <= nowSec()) return { kind: "anonymous" };
        return { kind: "shopper", shopperId: payload.sid, source: payload.src, verified: true };
      } catch {
        return { kind: "anonymous" };
      }
    },
    authorize(principal, action): boolean {
      return authorize(principal, action);
    },
  };
}
