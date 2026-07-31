import type { MemoryConsent, Region } from "./consent.js";
import type { FactClass, TenantSensitivityPolicy } from "./classifier.js";

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
}

export interface MemoryService {
  /** Distill + classify + consent-gate + (maybe) persist facts from one turn. No-op `{written: []}`
   * touching nothing when the double gate (flag.ts) is off. */
  remember(ctx: MemoryCtx, turn: MemoryTurn): Promise<{ written: FactClass[] }>;
  /** Read this subject's non-expired facts. `[]` (touching nothing) when the double gate is off. */
  recall(ctx: MemoryCtx): Promise<RecalledFact[]>;
}
