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
  /**
   * semantic-memory-v1 T4 (governance-critical): `true` iff this record's `vector` is a PLACEHOLDER —
   * not derived from embedding this record's own plaintext — because the fact is special-category and
   * special-category plaintext is NEVER sent to an embedding provider (the Art-9 privacy boundary).
   * A caller doing real semantic recall (a later PR) MUST treat a `mustRecall:true` record as "always
   * surface via the non-semantic floor (`list`), never rank/rank-out by vector similarity" — the
   * placeholder carries no information about the fact's content, so ranking it against a query vector
   * is meaningless (T4's whole point), and OMITTING it from recall merely because it doesn't score well
   * would silently drop a shopper's own consented data. Absent/false on every ordinary record (real
   * content-derived vector) and on every record written before this PR (no field at all).
   */
  mustRecall?: boolean;
  /**
   * semantic-memory-v1 T5 (write-time dedup for special-category facts): a keyed-HMAC over this record's
   * SANITIZED plaintext (pre-encryption), used for EXACT-MATCH dedup only — never a vector similarity
   * over health/Art-9 text (service.ts's own dedup note). Set only when `class === "special"` and
   * `MEMORY_SEMANTIC_RECALL` is on at write time; absent otherwise (including every pre-PR record).
   */
  dedupTag?: string;
}

export interface MemoryService {
  /** Distill + classify + consent-gate + (maybe) persist facts from one turn. No-op `{written: []}`
   * touching nothing when the double gate (flag.ts) is off. */
  remember(ctx: MemoryCtx, turn: MemoryTurn): Promise<{ written: FactClass[] }>;
  /** Read this subject's non-expired facts. `[]` (touching nothing) when the double gate is off. */
  recall(ctx: MemoryCtx): Promise<RecalledFact[]>;
}
