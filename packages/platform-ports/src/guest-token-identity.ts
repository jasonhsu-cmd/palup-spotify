import { randomBytes } from "node:crypto";
import { b64url, b64urlDecode, hmacSign, constantTimeEqual } from "./token-codec.js";

// ADR-0019 (Revision 2) — server-issued guest identity. A short-TTL, PalUp-signed token that binds a
// browser to a SERVER-GENERATED anonymous id at a specific tenant. Mirrors widget-token-identity.ts /
// shopper-token-identity.ts (same HMAC-SHA256 + base64url codec, node:crypto only) with two differences
// the security review required:
//
//   * A SEPARATE secret (`GUEST_TOKEN_SECRET`, R2-4). NOT the widget/shopper secret — a compromise of one
//     token type's key must not let an attacker forge another's. The `typ` claim is defence-in-depth on
//     top of that, never instead of it (F-4: there is no repo precedent for sharing a secret across token
//     types — shopper and widget already use different secrets).
//   * A mandatory `tid` (tenant) claim (R2-5). A guest token is valid ONLY at the tenant it was minted
//     for; verified against the request's merchant principal at the call site. Without `tid` one id would
//     key `A::aid` and `B::aid` across merchants, breaking ADR-0015 Inv 8's per-tenant isolation.
//
// WHY VERIFY-TO-CLAIMS, NOT AUTHENTICATE-TO-PRINCIPAL. A guest token authorises NOTHING — it only names a
// memory subject. Forcing it into the `Principal`/`authorize` model would add a Principal case every
// exhaustive switch and `authorize()` must then handle and deny, i.e. more surface for no capability. So
// this adapter verifies to `{ anonId, tid }` (or null), and the guest never appears as a Principal. The
// carry-over/consent/forget call sites use the verified `anonId` as the subject; they grant no actions
// off it.
//
// INVARIANT 3 (mint never accepts a client id) is STRUCTURAL here: `mintGuestToken` has no `anonId`
// parameter — it generates one via `generateGuestId()` — so there is no seam through which a caller could
// propose an id. INVARIANT 11 (mint writes nothing) is structural too: this module touches no store.

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // RFC4648 base32, no padding
const GUEST_ID_BYTES = 16; // 128 bits — matches widget-memory/identity.ts generateGuestId + validateAnonId

/**
 * A fresh, server-generated, per-mint anonymous id: 128 bits of `crypto.randomBytes`, base32-encoded.
 * Format-identical to `@palup/widget-memory`'s `generateGuestId` (26 chars, `[A-Z2-7]`), so it passes
 * `validateAnonId` and is a legal `subjectNamespace` component. Duplicated here rather than imported
 * because platform-ports is the lowest layer and must not depend on widget-memory (that would be a
 * cycle); widget-memory may re-export this one in a later cleanup to collapse to a single source.
 */
function generateGuestId(): string {
  const buf = randomBytes(GUEST_ID_BYTES);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** The verified claims of a guest token: a subject id and the tenant it is bound to. */
export interface GuestClaims {
  anonId: string;
  tid: string;
}

/** The wire shape of a guest token's body. All three fields are mandatory; any missing/blank ⇒ reject. */
interface GuestTokenBody {
  typ?: unknown;
  tid?: unknown;
  aid?: unknown;
  exp?: unknown;
}

/**
 * Mint a guest token bound to `tid`, valid for `ttlSeconds`, over a FRESH server-generated id. Returns
 * both the token and the id it was minted for (the caller stores/echoes the token; the id is the memory
 * subject). No `anonId` parameter by design (invariant 3). Signs only — like `mintWidgetToken`, it
 * performs no verification and touches no store (invariant 11).
 */
export function mintGuestToken(
  secret: string,
  tid: string,
  ttlSeconds: number,
  nowSec = Math.floor(Date.now() / 1000),
): { token: string; anonId: string } {
  const anonId = generateGuestId();
  const body = b64url(Buffer.from(JSON.stringify({ typ: "guest", tid, aid: anonId, exp: nowSec + ttlSeconds })));
  return { token: `${body}.${hmacSign(secret, body)}`, anonId };
}

/**
 * Parse + verify a guest token's signature and claims, returning the decoded body only if the signature
 * is valid, `typ === "guest"`, `tid`/`aid` are non-blank strings, and `exp` is a number strictly in the
 * future. Returns `null` on ANY failure. Shared by `verify` and `renewGuestToken` so the two can never
 * drift on what "a valid guest token" means. `requireUnexpired=false` lets a caller inspect claims of an
 * expired token only where that is explicitly safe — it is NOT used today; both callers require unexpired.
 */
function parseVerified(secret: string | undefined, credential: string | undefined, nowSec: number): GuestTokenBody | null {
  if (!secret || !credential) return null;
  const dot = credential.indexOf(".");
  if (dot <= 0 || credential.indexOf(".", dot + 1) !== -1) return null; // exactly one "."
  const body = credential.slice(0, dot);
  const sig = credential.slice(dot + 1);
  if (!constantTimeEqual(sig, hmacSign(secret, body))) return null;
  let payload: GuestTokenBody;
  try {
    payload = JSON.parse(b64urlDecode(body).toString("utf8")) as GuestTokenBody;
  } catch {
    return null;
  }
  if (payload.typ !== "guest") return null; // token-type separation (defence-in-depth over the secret)
  if (typeof payload.tid !== "string" || !payload.tid) return null; // an untenanted guest token cannot exist
  if (typeof payload.aid !== "string" || !payload.aid) return null;
  if (typeof payload.exp !== "number" || payload.exp <= nowSec) return null; // expiry, invariant 6
  return payload;
}

/**
 * Re-issue a token for the SAME `aid`/`tid` with a new expiry (invariant 6). Verifies the presented token
 * fully first — signature, `typ`, `tid`, `aid`, AND expiry — and REFUSES an expired one (so a stolen guest
 * token cannot be kept alive indefinitely by refreshing after it lapses). Takes the token, never a raw id.
 * Returns `null` on any invalid/expired input.
 */
export function renewGuestToken(
  secret: string,
  credential: string,
  ttlSeconds: number,
  nowSec = Math.floor(Date.now() / 1000),
): { token: string; anonId: string } | null {
  const claims = parseVerified(secret, credential, nowSec);
  if (!claims) return null;
  const tid = claims.tid as string;
  const anonId = claims.aid as string;
  const body = b64url(Buffer.from(JSON.stringify({ typ: "guest", tid, aid: anonId, exp: nowSec + ttlSeconds })));
  return { token: `${body}.${hmacSign(secret, body)}`, anonId };
}

/**
 * Guest-token verifier. `verify(credential, opts?)` returns the token's `{ anonId, tid }` when it is a
 * valid, unexpired guest token, else `null` (never throws — the adapter contract). When `opts.tenantId`
 * is supplied, the token's `tid` MUST equal it (invariant 7); a mismatch yields `null`. Callers on a
 * tenant-scoped request MUST pass `tenantId` so a token minted for another shop cannot be replayed here.
 */
export function createGuestTokenIdentity(
  secret: string | undefined,
  nowSec = () => Math.floor(Date.now() / 1000),
): { verify(credential: string | undefined, opts?: { tenantId?: string }): Promise<GuestClaims | null> } {
  return {
    async verify(credential, opts): Promise<GuestClaims | null> {
      const claims = parseVerified(secret, credential, nowSec());
      if (!claims) return null;
      const tid = claims.tid as string;
      if (opts?.tenantId !== undefined && opts.tenantId !== tid) return null; // invariant 7
      return { anonId: claims.aid as string, tid };
    },
  };
}
