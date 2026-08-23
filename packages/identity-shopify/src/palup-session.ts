import { b64url, b64urlDecode, hmacSign, constantTimeEqual } from "@palup/platform-ports";
import type { MerchantPrincipal, AnonymousPrincipal, MerchantRole, AuthLevel } from "@palup/platform-ports";

// The PalUp SESSION token (ADR-0011 Dec 1: "a PalUp session scoped to that merchant_id + user + role").
// Minted once, after a validated single-use session-token exchange; presented on every SUBSEQUENT
// console request so we never re-exchange. Domain-separated by a mandatory `typ` (ADR-0017 F1): a widget
// or shopper token signed with the same secret can NEVER verify here, and vice versa. HMAC-SHA256 over
// the shared codec — no external JWT lib (portable). Short TTL; the full revocation store (sign-out-all,
// refresh rotation) is DEFERRED (spec §3) — a token simply expires. Fails closed to `anonymous`.
//
// NOTE: this token embeds `role`. A W7 role CHANGE takes full effect at the next mint (≤ TTL); F3 may
// force an earlier re-mint on a role-change event. The short TTL bounds the staleness window.

const TYP = "palup-merchant-session";
const ROLES: ReadonlySet<string> = new Set(["viewer", "operator", "manager", "admin", "owner"]);
const anon: AnonymousPrincipal = { kind: "anonymous" };

interface SessionClaims { typ: string; m: string; u: string; r: MerchantRole; al: AuthLevel; sid: string; exp: number; }

export function mintMerchantSession(
  secret: string,
  p: { merchantId: string; userId: string; role: MerchantRole; authLevel: AuthLevel; sid: string },
  ttlSeconds: number, nowSec: number = Math.floor(Date.now() / 1000),
): string {
  const claims: SessionClaims = {
    typ: TYP, m: p.merchantId, u: p.userId, r: p.role, al: p.authLevel, sid: p.sid, exp: nowSec + ttlSeconds,
  };
  const body = b64url(Buffer.from(JSON.stringify(claims)));
  return `${body}.${hmacSign(secret, body)}`;
}

export function verifyMerchantSession(
  secret: string | undefined, token: string | undefined, nowSec: number = Math.floor(Date.now() / 1000),
): MerchantPrincipal | AnonymousPrincipal {
  if (!secret || !token) return anon;
  const dot = token.indexOf(".");
  if (dot <= 0) return anon;
  const body = token.slice(0, dot), sig = token.slice(dot + 1);
  if (!constantTimeEqual(sig, hmacSign(secret, body))) return anon;
  try {
    const c = JSON.parse(b64urlDecode(body).toString("utf8")) as Partial<SessionClaims>;
    if (c.typ !== TYP) return anon;                          // typ separation
    if (typeof c.exp !== "number" || c.exp <= nowSec) return anon;
    if (typeof c.m !== "string" || !c.m) return anon;
    if (typeof c.u !== "string" || !c.u) return anon;
    if (typeof c.sid !== "string" || !c.sid) return anon;
    if (typeof c.r !== "string" || !ROLES.has(c.r)) return anon; // forged/unknown role ⇒ anonymous
    if (c.al !== "session" && c.al !== "elevated") return anon;
    return { kind: "merchant_user", merchantId: c.m, userId: c.u, role: c.r as MerchantRole,
             authLevel: c.al, sessionId: c.sid };
  } catch { return anon; }
}
