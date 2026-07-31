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
