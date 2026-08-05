import type { MemoryConsent, Region } from "./consent.js";
import type { FactClass, TenantSensitivityPolicy } from "./classifier.js";
import type { Disposition } from "./disposition.js";

// Public request/response shapes for the memory service (T7). Kept in their own module so both
// service.ts and index.ts can depend on them without a cycle.

/** Everything a call needs to know about WHO is being remembered/recalled and under what consent. */
export interface MemoryCtx {
  tenantId: string;
  /** The guest anon id, or the account id post sign-up merge — either way, the Option B subject key. */
  anonId: string;
  /** Server-derived shopper jurisdiction; absent behaves like "eu"/"unknown" (fail closed). */
  region?: Region;
  /** Consent 1 — ordinary personal-data / cross-visit memory. */
  consent1: MemoryConsent;
  /** Consent 2 — explicit special-category / health-data consent. Independent of consent1. */
  consent2: MemoryConsent;
  /** This tenant's reviewed sensitivity policy (may only narrow, never reclassify — Inv 11). */
  tenantPolicy?: TenantSensitivityPolicy;
}

/** One conversational turn to distill candidate facts from. Never persisted verbatim (Inv 1). */
export interface MemoryTurn {
  message: string;
  reply: string;
}

/** A fact recalled from durable memory, with its sensitivity class attached so the caller (the brain's
 * grounding/personalization) can honor Inv 10 — a special-category fact may only add caution. */
export interface RecalledFact {
  text: string;
  class: FactClass;
  /** Persona-disposition layer (PR-0, inert): durable style/preference signals extracted with the fact.
   * Consent-gated + fairness-structural (no inferred provenance). */
  disposition?: Disposition[];
}

/** The shape every stored fact's `VectorRecord.metadata` carries (service.ts `remember`/`recall`; also
 * read by retention.ts/erasure.ts/merge.ts, T8-T10). Kept here — not in service.ts — so those modules
 * can depend on the shape without ever importing service.ts itself (avoids a cycle: service.ts imports
 * `ttlForClass` from retention.ts). */
export type FactMetadata = {
  text: string;
  class: FactClass;
  expiresAt: string; // ISO-8601
  /** Persona-disposition layer (PR-0, inert): dispositions stored alongside the fact (fairness-structural). */
  disposition?: Disposition[];
  /**
   * Encryption-at-rest marker (ADR-0015 Inv 9, go-live blocker #2): `true` iff `text` — and, when
   * present, each `disposition[].value` and `disposition[].sourceQuote` — is an AES-256-GCM `CryptoPort`
   * envelope rather than plaintext. Set precisely at WRITE time (service.ts `remember`) from whether an
   * encryption key was actually available for this tenant; NEVER inferred from the string's shape.
   * `recall` decrypts a field ONLY when this is `true` — a record with `encrypted` absent/false is read
   * as already-plaintext (the ordinary no-key best-effort fallback, or any record seeded directly at the
   * vector-port layer, e.g. by a test or a future migration tool, bypassing `remember()` entirely).
   */
  encrypted?: boolean;
}

export interface MemoryService {
  /** Distill + classify + consent-gate + (maybe) persist facts from one turn. No-op `{written: []}`
   * touching nothing when the double gate (flag.ts) is off. */
  remember(ctx: MemoryCtx, turn: MemoryTurn): Promise<{ written: FactClass[] }>;
  /** Read this subject's non-expired facts. `[]` (touching nothing) when the double gate is off. */
  recall(ctx: MemoryCtx): Promise<RecalledFact[]>;
}
