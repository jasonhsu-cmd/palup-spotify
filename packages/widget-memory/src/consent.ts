import type { Consent, Signals } from "@palup/widget-brain";
import { consentPermits } from "@palup/widget-brain";

// Pure decision table, no I/O (ADR-0015 "Consent UX" + Inv 3/9). Region + the two consent signals are
// server-derived (never client-forced) and passed in by the caller; this module only decides whether a
// write MAY happen — it does not read/write anything itself.
//
// Reuses widget-brain's existing tri-state `Consent` ("in"|"out"|"unknown" — brain/types.ts) and the
// exact `region` union already carried on `Signals` (brain TYPES only, per the package dependency),
// rather than inventing a parallel type.

/** Alias of widget-brain's `Consent` — kept as a named export here so callers of this package don't
 * need to reach into widget-brain directly for the memory-consent vocabulary. */
export type MemoryConsent = Consent;

/** Shopper jurisdiction — reuses the exact union widget-brain's `Signals.region` already carries. */
export type Region = Signals["region"];

export interface ConsentInputs {
  /** Shopper jurisdiction (server-derived). Absent is treated exactly like "eu"/"uk"/"other" — unknown
   * region fails closed (ADR-0015 Inv 3). */
  region?: Region;
  /** Consent 1 — ordinary personal-data / cross-visit memory (Art. 6). */
  consent1: MemoryConsent;
  /** Consent 2 — explicit special-category / health-data consent (Art. 9). Independent of Consent 1. */
  consent2: MemoryConsent;
}

export interface WriteCapability {
  mayWriteOrdinary: boolean;
  mayWriteSpecial: boolean;
  /** Human-readable trace of why, for audit/debugging — not machine-parsed. */
  reason: string;
}

/**
 * ADR-0015 Inv 3 + Inv 9. Ordinary facts: `region === "us"` is an OPT-OUT regime (write unless the
 * shopper explicitly opted out); EVERY other region — "eu", "uk", "other", or unknown/undefined — is
 * fail-closed and requires explicit `consent1 === "in"`. Special-category facts ALWAYS require explicit
 * `consent2 === "in"`, in every region including the US, completely independent of `consent1` (Inv 9,
 * scope B) — a shopper opted OUT of ordinary memory can still consent to special-category memory alone,
 * and vice versa.
 *
 * Ratified by the ADR-0015 amendment (named owner + legal, 2026-08-04): applying the EU-style fail-closed
 * rule to Consent 2 even in the US (rather than the US ordinary opt-out regime) is the ratified default —
 * special-category / health-data memory ALWAYS requires explicit `consent2 === "in"`, in every region
 * including the US, given emerging US state health-privacy law. Ordinary-fact memory keeps the US opt-out
 * regime; only special-category is fail-closed everywhere.
 */
/** One subject's recorded tri-states for BOTH consent tiers — structurally the same shape as
 * state-postgres's `ConsentRecord` (kept independent here, not imported, so this package never depends
 * on state-postgres). */
export interface ConsentTiers {
  memoryOrdinary: MemoryConsent;
  memorySpecial: MemoryConsent;
}

/**
 * BLOCK-1 fix (security-review remediation, PR #152) — restrictive-merge, for ONE tier, of an ACCOUNT
 * subject's recorded consent with an optional GUEST subject's recorded consent.
 *
 * WHY THIS EXISTS: subject-scoped auth (identity.ts `memorySubjectId`) rebinds the cross-visit-memory
 * subject from a raw client-supplied `anonId` to the server-verified `acct:<shopperId>` once a shopper
 * signs in. Looking up consent by the NEW subject key alone means a choice the shopper recorded as a
 * GUEST — in particular an explicit "out" — simply stops resolving the instant they sign in (the
 * `acct:` row doesn't exist yet), degrading to the fail-closed default ("unknown"). In the US opt-out
 * regime (`decideMemoryWrite`: `consent1 !== "out"`), "unknown" reads as ALLOWED — so sign-in would
 * silently VOID an explicit opt-out. Proven by execution (two independent security reviews): guest
 * records "out" -> 0 writes; the SAME person signs in -> 1 write. `decideMemoryWrite`'s own logic never
 * changed; only its INPUT regressed with the subject-derivation switch.
 *
 * THE RULE (most-restrictive-wins):
 *   - An "out" on EITHER side wins outright — an opt-out must survive sign-in.
 *   - An "in" is adopted ONLY from the ACCOUNT record. A guest "in" is NEVER promoted to the account,
 *     because — unlike the subject derivation itself, which trusts the SERVER-verified principal — the
 *     guest `anonId` is still client-SUPPLIED and unauthenticated. Adopting a guest "in" would let
 *     anyone borrow a stranger's opt-in merely by holding/guessing their anonId post sign-in.
 *   - Otherwise "unknown" (neither side has decided).
 *
 * The caller is responsible for only ever passing a `guestValue` when the client supplied a validated
 * `anonId` THIS request (never an unvalidated string) — see `mergeAccountConsent`'s own caller in
 * server.ts. Passing `undefined` for `guestValue` (no anonId supplied) collapses this to "the account
 * record alone", which is the correct behavior for a shopper who never presents a guest id.
 */
export function mergeConsentTier(accountValue: MemoryConsent, guestValue: MemoryConsent | undefined): MemoryConsent {
  if (accountValue === "out" || guestValue === "out") return "out";
  if (accountValue === "in") return "in";
  return "unknown";
}

/**
 * Applies `mergeConsentTier` to BOTH consent tiers at once — the single, named, unit-tested place this
 * restrictive-merge rule lives (do not scatter it across call sites). `guest` is `undefined` exactly
 * when there is no guest record to consult this turn (no validated anonId supplied, or none ever
 * recorded), in which case the result is `account` unchanged.
 */
export function mergeAccountConsent(account: ConsentTiers, guest: ConsentTiers | undefined): ConsentTiers {
  return {
    memoryOrdinary: mergeConsentTier(account.memoryOrdinary, guest?.memoryOrdinary),
    memorySpecial: mergeConsentTier(account.memorySpecial, guest?.memorySpecial),
  };
}

export function decideMemoryWrite(i: ConsentInputs): WriteCapability {
  const isUs = i.region === "us";
  // Delegates to the SINGLE consent rule (@palup/widget-brain consent-rules.ts), which the read gate
  // (brain.ts `consentedAtReadTime`) and the sliding-retention renewal (service.ts) also call. The rule
  // used to be written out here AND again at the read site with a different bar, which is exactly how
  // checklist row B7 arose — the US wrote ordinary facts on "unknown" and could then never surface them.
  // One definition, three callers; changing the regime is now a one-line change that moves all of them.
  const mayWriteOrdinary = consentPermits(i.region, "ordinary", i.consent1);
  const mayWriteSpecial = consentPermits(i.region, "special", i.consent2);

  const reason = [
    isUs
      ? `ordinary: us opt-out regime — consent1=${i.consent1} → ${mayWriteOrdinary ? "allowed" : "opted out"}`
      : `ordinary: region=${i.region ?? "unknown"} fails closed — consent1=${i.consent1} → ${mayWriteOrdinary ? "explicit consent granted" : "explicit consent required"}`,
    `special: explicit health consent required in every region — consent2=${i.consent2} → ${mayWriteSpecial ? "granted" : "not granted"}`,
  ].join("; ");

  return { mayWriteOrdinary, mayWriteSpecial, reason };
}
