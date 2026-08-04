import { randomBytes } from "node:crypto";

// ADR-0015 Inv 2 (per-tenant isolation, no cross-namespace read) + Inv 8 (the anonymous id is not a
// tracking identifier — first-party, per-tenant, random; not device-fingerprinted; resettable). This
// module owns id minting + the OPTION B namespace scheme (`${tenantId}::${anonId}`) that keys the
// vector port (packages/platform-ports/src/vector-port.ts): it gives isolation, complete per-subject
// erasure (deleteById), and precise per-subject recall from the port as-is, with no new port surface.

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // RFC4648 base32, no padding
const GUEST_ID_BYTES = 16; // 128 bits of randomness
const NAMESPACE_SEPARATOR = "::";

function toBase32(buf: Buffer): string {
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

/**
 * A stable, first-party, per-tenant anonymous id: 128 bits of `crypto.randomBytes`, base32-encoded.
 * Deliberately takes NO arguments — nothing device-, browser-, or shopper-derived ever feeds it, so it
 * carries no fingerprinting signal (ADR-0015 Inv 8). Resettable by construction: there is nothing to
 * reconstruct it from, so clearing client storage genuinely forgets the shopper.
 */
export function generateGuestId(): string {
  return toBase32(randomBytes(GUEST_ID_BYTES));
}

function requireNonBlankNoSeparator(value: string, label: string): void {
  if (!value || !value.trim())
    throw new Error(`subjectNamespace: ${label} must not be blank`);
  if (value.includes(NAMESPACE_SEPARATOR))
    throw new Error(
      `subjectNamespace: ${label} must not contain "${NAMESPACE_SEPARATOR}" (would allow namespace injection)`,
    );
}

/**
 * OPTION B namespace: `${tenantId}::${anonId}` (or account id post sign-up merge). Keys the vector
 * port directly — the port's namespace IS the tenant, and Option B nests the subject inside it, giving
 * per-subject erasure (deleteById within the namespace) without a new port capability. `::` is reserved
 * as the separator, so it is rejected in either component — otherwise a crafted anonId like
 * `"other-tenant::victim"` could forge a read/write into another subject's slot.
 */
export function subjectNamespace(tenantId: string, anonId: string): string {
  requireNonBlankNoSeparator(tenantId, "tenantId");
  requireNonBlankNoSeparator(anonId, "anonId");
  return `${tenantId}${NAMESPACE_SEPARATOR}${anonId}`;
}

// Charset + length bound for a CLIENT-SUPPLIED anon id before it is trusted as a namespace component.
// Generated ids are base32, ~26 chars for 128 bits; bounded generously (10-64) so a legitimately
// generated id always validates while an oversized/adversarial string never does.
const ANON_ID_PATTERN = /^[A-Z2-7]{10,64}$/;

/**
 * Validates a client-supplied anon id is well-formed (charset + length bounded). Returns the id
 * unchanged if valid, else `undefined` — NEVER throws, so a caller can fall back to minting a fresh id
 * via `generateGuestId()` rather than ever trusting an attacker-controlled string as a namespace part.
 */
export function validateAnonId(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  return ANON_ID_PATTERN.test(raw) ? raw : undefined;
}

/** The subject id for a SIGNED-IN shopper. Prefixed so an account subject can never collide with a
 * generated guest id (base32 has no `:` or lowercase), and so a namespace is self-describing on sight.
 * Defined here — not in merge.ts, where it started — because three callers now key off it (the merge,
 * the serving path, and the consent/erasure endpoints) and a second definition would be a silent
 * cross-subject bug waiting to happen. */
export function accountSubjectId(accountId: string): string {
  return `acct:${accountId}`;
}

/**
 * The one place the cross-visit-memory SUBJECT is decided (subject-scoped auth).
 *
 * Before this existed, every memory surface — the serving path, `POST /consent`, and the DESTRUCTIVE
 * `POST /forget` — keyed off a raw client-supplied `anonId`. `validateAnonId` proves a string is
 * well-FORMED, never that the caller OWNS it, and widget auth binds only the TENANT. So within one
 * tenant, anyone holding another shopper's `anonId` could set their consent or delete their memory.
 *
 * Rule: **a server-verified shopper principal always wins.** When one is present the subject is
 * `acct:<shopperId>`, derived server-side, and any client-supplied `anonId` is IGNORED — the same
 * precedence ADR-0017 already applies to `tenantId`/`shopperId` ("server-derived MUST win"), not an
 * error, because a signed-in shopper's browser legitimately still holds its old guest id.
 *
 * `verifiedShopperId` MUST be passed only for a principal the server actually verified — presence of an
 * id is not verification (an id-set-but-unverified principal must never authorize; see the widget
 * backend's own `shopperVerified` note).
 *
 * Guests are unchanged: no principal exists to bind to, so the subject stays the validated `anonId` and
 * the bearer-capability residual persists for anonymous shoppers only. Note the two id kinds take
 * DIFFERENT validation paths — an `acct:` id is server-minted and deliberately never run through
 * `validateAnonId` (it would fail the base32 charset); both kinds are still guarded against `::`
 * injection by `subjectNamespace`.
 */
export function memorySubjectId(args: {
  verifiedShopperId?: string;
  rawAnonId?: unknown;
}): string | undefined {
  if (args.verifiedShopperId) return accountSubjectId(args.verifiedShopperId);
  return validateAnonId(typeof args.rawAnonId === "string" ? args.rawAnonId : undefined);
}
