import type { Consent, Signals } from "@palup/widget-brain";

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
 * LEGAL-APPROVED (2026): applying the EU-style fail-closed rule to Consent 2 even in the US (rather than
 * the US ordinary opt-out regime) is the ratified default — special-category / health-data memory ALWAYS
 * requires explicit `consent2 === "in"`, in every region including the US, given emerging US state
 * health-privacy law. Ordinary-fact memory keeps the US opt-out regime; only special-category is
 * fail-closed everywhere.
 */
export function decideMemoryWrite(i: ConsentInputs): WriteCapability {
  const isUs = i.region === "us";
  const mayWriteOrdinary = isUs ? i.consent1 !== "out" : i.consent1 === "in";
  const mayWriteSpecial = i.consent2 === "in";

  const reason = [
    isUs
      ? `ordinary: us opt-out regime — consent1=${i.consent1} → ${mayWriteOrdinary ? "allowed" : "opted out"}`
      : `ordinary: region=${i.region ?? "unknown"} fails closed — consent1=${i.consent1} → ${mayWriteOrdinary ? "explicit consent granted" : "explicit consent required"}`,
    `special: explicit health consent required in every region — consent2=${i.consent2} → ${mayWriteSpecial ? "granted" : "not granted"}`,
  ].join("; ");

  return { mayWriteOrdinary, mayWriteSpecial, reason };
}
