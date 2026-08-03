import { createHash } from "node:crypto";
import type { RuntimeStatePort } from "@palup/platform-ports";
import type { Consent } from "@palup/widget-brain";

// PR-11a — server-side consent-record plumbing (ADR-0015 T12). Mirrors runtime-kill-registry.ts's
// structure: tenant-scoped rows on the SAME RuntimeStatePort (Postgres in prod via DATABASE_URL,
// in-memory in tests) — one storage abstraction for both, no new port surface — and the write is
// committed INSIDE a transaction together with its immutable audit record (NN #5), so the consent
// change and its audit can never drift apart on a mid-write failure.
//
// This is ONLY the record/lookup plumbing that closes widget-backend/src/signals.ts's hardcoded
// `consent.memoryOrdinary/memorySpecial = "unknown"`. It does not decide anything: `decideMemoryWrite`
// (widget-memory/src/consent.ts, reused UNCHANGED) is still the sole place a region/consent-tier policy
// is applied. Recording/looking up a preference here is inert on its own — nothing acts on it until the
// (separately gated, still-false) MEMORY_ADR_ACCEPTED flip.
//
// TENANT SCOPING: unlike the kill registry (which needs a reserved SYSTEM tenant for cross-tenant
// operator scopes), a memory-consent record is inherently single-tenant — a shopper's choice for
// merchant A says nothing about merchant B. So this store keys directly off the CALLER's own
// RuntimeStateCtx.tenantId (mirrors customer-grant-store.ts's `{ tenantId: tenant }` keying), giving
// tenant isolation for free from the port's own guarantee — no manual scope-precedence logic needed.

const MEMORY_CONSENT = "memory_consent"; // KV collection under the subject's OWN tenant

/** The two independent ADR-0015 memory-consent tiers for one subject. */
export interface ConsentRecord {
  /** Consent 1 — ordinary personal-data / cross-visit memory (Art. 6). */
  memoryOrdinary: Consent;
  /** Consent 2 — explicit special-category / health-data consent (Art. 9). Independent of Consent 1. */
  memorySpecial: Consent;
}

export interface RecordConsentInput extends ConsentRecord {
  tenantId: string;
  /** The subject key — the SAME validated anonId (or account id, post-merge) `signals.anonId` carries. */
  anonId: string;
}

export interface LookupConsentInput {
  tenantId: string;
  anonId: string;
}

/** Fail-closed default when no record exists yet — never "in"/allowed by omission (mirrors
 * decideMemoryWrite's own fail-closed bias: an unknown consent state is never treated as granted). */
const NO_RECORD: ConsentRecord = { memoryOrdinary: "unknown", memorySpecial: "unknown" };

/** Opaque, one-way reference to a subject for the audit log — NEVER the raw anonId (mirrors
 * widget-memory/src/audit.ts's subjectRef and widget-backend/src/audit.ts's sessionRef pattern), so the
 * immutable, long-lived audit log can't itself become a re-identification surface. */
function subjectRef(tenantId: string, anonId: string): string {
  return createHash("sha256").update(`${tenantId}::${anonId}`).digest("hex").slice(0, 16);
}

/**
 * Persist a subject's memory-consent tri-states — TENANT-SCOPED (keyed under `input.tenantId`, never a
 * cross-tenant write), keyed by `input.anonId`. Overwrites any prior record for this subject (a fresh
 * choice always wins — there is no history to reconcile). Audited atomically with the write.
 */
export async function recordConsent(
  store: RuntimeStatePort,
  input: RecordConsentInput,
  at = new Date().toISOString(),
): Promise<void> {
  const { tenantId, anonId, memoryOrdinary, memorySpecial } = input;
  const record: ConsentRecord = { memoryOrdinary, memorySpecial };
  await store.tx({ tenantId }, async (t) => {
    await t.put(MEMORY_CONSENT, anonId, record);
    await t.audit(
      {
        actor: "shopper",
        action: "consent.record",
        // PII-safe: only a hashed subjectRef + the tri-state choices — never the raw anonId.
        input: { subjectRef: subjectRef(tenantId, anonId), memoryOrdinary, memorySpecial },
        decision: "recorded",
        reversalPath: "POST /consent again with a different choice (e.g. 'out') — a fresh choice always overwrites the prior one",
      },
      at,
    );
  });
}

/**
 * The subject's recorded memory-consent tri-states, or the fail-closed default (`"unknown"/"unknown"`)
 * when no record exists yet. TENANT-SCOPED — reads only ever see rows under `input.tenantId`; a record
 * written for one tenant is invisible to every other tenant, even for the identical `anonId`.
 */
export async function lookupConsent(store: RuntimeStatePort, input: LookupConsentInput): Promise<ConsentRecord> {
  const rec = await store.get<ConsentRecord>({ tenantId: input.tenantId }, MEMORY_CONSENT, input.anonId);
  return rec ?? NO_RECORD;
}
