import { createHmac, timingSafeEqual } from "node:crypto";

// Shopify App Bridge SESSION TOKEN (ID token) validator — a NAMED Shopify adapter behind the portable
// merchant-identity port (ADR-0001). node:crypto only, NO Shopify SDK (parity with
// shopify-install-identity.ts). PRIMARY SOURCE (retrieved 2026-08-23): shopify.dev "Session tokens" /
// "ID token claims" + "Token exchange". HS256 signed with the app client secret; claims iss/dest/aud/
// sub/exp/nbf/iat/jti/sid. Validation (verbatim): signature (HS256, client secret); exp future; nbf
// past; aud === client id; iss & dest hosts must match; else reject. Fails CLOSED, never throws (a bad
// token is an unauthenticated request, and an exception would be an error-message oracle).
//
// NOT VERIFIED: no golden token captured from a live App Bridge session yet — this checks our reading
// of the spec for internal consistency; a real (secret, token) pair is still required before go-live
// (same caveat shopify-install-identity.ts records for install HMACs).

export interface ShopifySessionClaims {
  iss: string; dest: string; aud: string; sub: string;
  exp: number; nbf: number; iat: number; jti: string; sid: string;
}
export type SessionVerifyResult =
  | { ok: true; claims: ShopifySessionClaims; shopDomain: string }
  | { ok: false; reason: string };

const SHOP_HOST = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i; // byte-identical to shopify-install-identity.ts

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
function hs256(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function ctEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
/** Host from `https://<host>[/...]`; undefined if not an https URL. */
function hostOf(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  try { const u = new URL(v); return u.protocol === "https:" ? u.host.toLowerCase() : undefined; }
  catch { return undefined; }
}

export function verifyShopifySessionToken(args: {
  token: string | undefined; clientSecret: string | undefined; clientId: string; nowSec: number;
}): SessionVerifyResult {
  const { token, clientSecret, clientId, nowSec } = args;
  if (!clientSecret) return { ok: false, reason: "app client secret not configured (fail-closed)" };
  if (!token) return { ok: false, reason: "session token required" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed session token (want 3 JWT segments)" };
  const [h, p, sig] = parts;
  if (!h || !p || !sig) return { ok: false, reason: "malformed session token (empty JWT segment)" }; // the length check above does not narrow a destructure
  // Signature BEFORE parsing/trusting the payload.
  if (!ctEqual(sig, hs256(clientSecret, `${h}.${p}`))) return { ok: false, reason: "bad session-token signature" };
  let raw: Partial<ShopifySessionClaims>;
  try { raw = JSON.parse(b64urlDecode(p).toString("utf8")); }
  catch { return { ok: false, reason: "unparseable session-token payload" }; }
  if (raw.aud !== clientId) return { ok: false, reason: "aud mismatch (token minted for another app)" };
  if (typeof raw.exp !== "number" || raw.exp <= nowSec) return { ok: false, reason: "session token expired" };
  if (typeof raw.nbf !== "number" || raw.nbf > nowSec) return { ok: false, reason: "session token not yet valid" };
  const issHost = hostOf(raw.iss), destHost = hostOf(raw.dest);
  if (!issHost || !destHost || issHost !== destHost) return { ok: false, reason: "iss/dest host mismatch" };
  if (!SHOP_HOST.test(destHost)) return { ok: false, reason: "dest is not a *.myshopify.com host" };
  if (typeof raw.sub !== "string" || !raw.sub) return { ok: false, reason: "missing sub" };
  if (typeof raw.jti !== "string" || !raw.jti) return { ok: false, reason: "missing jti" };
  if (typeof raw.sid !== "string" || !raw.sid) return { ok: false, reason: "missing sid" };
  return { ok: true, claims: raw as ShopifySessionClaims, shopDomain: destHost };
}
