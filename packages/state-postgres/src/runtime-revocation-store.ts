import { createHash, createHmac } from "node:crypto";
import type { RuntimeStatePort } from "@palup/platform-ports";

// ADR-0019 Revision 2, Task 5 / R2-7 — guest-credential revocation. An `aid → revokedAt` record on the
// SAME RuntimeStatePort as the consent store (Postgres in prod via DATABASE_URL, in-memory in tests) — one
// storage abstraction, no new port surface — written INSIDE a transaction together with its immutable audit
// record (NN #5), so the revocation and its audit can never drift apart on a mid-write failure. Mirrors
// runtime-consent-store.ts exactly.
//
// WHAT IT IS FOR. Consulted at guest-subject derivation (invariant 8: a revoked `aid` verifies as
// anonymous) and at RENEW (IC-1: the guest endpoint must not renew a revoked credential). Written on
// forget-me, so rotating away from a credential actually invalidates it instead of leaving a working copy
// in a thief's hands.
//
// WHY THIS IS SAFE (the reasoning the ADR's R2-7 pins, so it can't drift):
//   • RESTRICTIVE DIRECTION ONLY. A record can make a credential LESS capable (revoked ⇒ anonymous), never
//     MORE. So it can never become the permissive last-verified-writer-wins capability that was proven
//     unsafe on feat/c15-revocable-link @ d654c66. There is no "un-revoke".
//   • KEYED ON A SERVER-MINTED id. You cannot choose your `aid` (mintGuestToken randomises it) and you must
//     hold the signed token to use it, so this is not a squattable third link table (F-11).
//   • WRITTEN ON AN AUTHENTICATED PATH. forget-me derives the `aid` from a VERIFIED guest token, never a
//     client string — so it does not violate F-14's no-write-at-mint rule (mint stays pure-HMAC).
//
// TENANT SCOPING: a guest `aid` belongs to exactly one tenant (its token carries `tid`, R2-5). Keys directly
// off the caller's own RuntimeStateCtx.tenantId — a revocation for merchant A is invisible to merchant B for
// the identical `aid`, tenant isolation for free from the port's own guarantee (mirrors runtime-consent-store).

const GUEST_REVOCATION = "guest_revocation"; // KV collection under the subject's OWN tenant

/** What is stored per revoked `aid`. `revokedAt` is informational (the record's PRESENCE is what matters). */
export interface GuestRevocationRecord {
  revokedAt: string;
}

export interface RevokeGuestInput {
  tenantId: string;
  /** The server-minted guest `aid`, derived from a VERIFIED token — NEVER a client-supplied string (else
   * revoking a *named* aid would be a C10 denial primitive; the token requirement is what prevents that). */
  anonId: string;
  /** Keyed-HMAC key for the audit `subjectRef` (mirrors recordConsent's `hmacKey`). A guest `aid` is a
   * 128-bit CSPRNG value, so the unkeyed sha256 fallback is already non-brute-forceable here; supplying the
   * key keeps every subjectRef in the log under one keying scheme. */
  hmacKey?: string;
}

export interface IsGuestRevokedInput {
  tenantId: string;
  anonId: string;
}

/** Opaque, PII-safe reference for the audit log — NEVER the raw `aid` (mirrors runtime-consent-store's
 * subjectRef and widget-backend/src/audit.ts), so the immutable log can't itself become a re-id surface. */
function subjectRef(tenantId: string, anonId: string, hmacKey?: string): string {
  const input = `${tenantId}::${anonId}`;
  return hmacKey ? createHmac("sha256", hmacKey).update(input).digest("hex").slice(0, 16) : createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/**
 * Revoke a guest `aid` — TENANT-SCOPED (keyed under `input.tenantId`), keyed by `input.anonId`. Idempotent:
 * re-revoking overwrites the same restrictive record (a fresh `revokedAt`, same PRESENCE). Audited atomically
 * with the write. The reversal path is honest that revocation is NOT reversible by design — see R2-7.
 */
export async function revokeGuest(store: RuntimeStatePort, input: RevokeGuestInput, at = new Date().toISOString()): Promise<void> {
  const { tenantId, anonId, hmacKey } = input;
  await store.tx({ tenantId }, async (t) => {
    await t.put(GUEST_REVOCATION, anonId, { revokedAt: at } satisfies GuestRevocationRecord);
    await t.audit(
      {
        actor: "shopper", // forget-me is the shopper's own destructive action, not a server inference
        action: "guest.revoke",
        // PII-safe: only a hashed subjectRef — never the raw aid.
        input: { subjectRef: subjectRef(tenantId, anonId, hmacKey) },
        decision: "revoked",
        reversalPath:
          "NOT reversible by design (R2-7): a revoked guest credential stays revoked — there is no un-revoke, " +
          "because a re-enable switch would resurrect a token a thief may hold. The shopper is never locked " +
          "out: the widget mints a FRESH guest identity on the next visit (a new, empty anonymous namespace). " +
          "Restrictive-direction only.",
      },
      at,
    );
  });
}

/**
 * Is this guest `aid` revoked? TENANT-SCOPED — sees only rows under `input.tenantId`. The record's PRESENCE
 * is the signal; a missing record means "not revoked" (the live default). Callers MUST decide their own
 * fail behaviour on a store error — this function does not swallow it, so a caller can fail CLOSED (treat an
 * unconfirmable credential as revoked/anonymous) where invariant 8 demands it.
 */
export async function isGuestRevoked(store: RuntimeStatePort, input: IsGuestRevokedInput): Promise<boolean> {
  const rec = await store.get<GuestRevocationRecord>({ tenantId: input.tenantId }, GUEST_REVOCATION, input.anonId);
  return rec != null;
}
