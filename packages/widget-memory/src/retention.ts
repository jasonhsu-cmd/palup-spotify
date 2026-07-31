import type { RuntimeStatePort, VectorPort } from "@palup/platform-ports";
import { subjectNamespace } from "./identity.js";
import { buildMemoryAudit } from "./audit.js";
import type { FactClass } from "./classifier.js";
import type { FactMetadata } from "./types.js";

// ADR-0015 Invariant 4 (retention TTL, "expiry is enforced, not aspirational") + Invariant 9 (special-
// category facts get stricter handling, including "a shorter TTL than the 60-day default"). This module
// is the single source of truth for the TTL day-counts: service.ts's `remember` (TTL-on-write, stamps
// `metadata.expiresAt`) and `recall` (TTL-on-read, drops an expired fact even though it is still
// physically stored) both key off `ttlForClass` here, so the two can never drift apart. `sweepExpired`
// is the periodic reclamation half — it actually deletes what TTL-on-read merely hides — mirroring
// RuntimeStatePort's own `sweepExpired` (expiry enforced on read; sweeping reclaims storage).

const DAY_MS = 24 * 60 * 60 * 1000;

/** Default guest/ordinary-fact retention (ADR-0015 Inv 4). The ADR marks the exact figure "Still open —
 * resolve before Accepted"; 60 days is the ADR's own suggested placeholder pending legal review.
 * UNVERIFIED-with-legal. */
export const ORDINARY_TTL_DAYS = 60;

/** Shorter retention for special-category (Art. 9) facts (ADR-0015 Inv 9: "stricter handling ... a
 * shorter TTL than the 60-day default"). The ADR's "Still open" note suggests 7-14 days; 14 is used here
 * pending legal sign-off. UNVERIFIED-with-legal. */
export const SPECIAL_TTL_DAYS = 14;

/**
 * The TTL for a fact of the given sensitivity class, in MILLISECONDS — add to a clock reading (`now +
 * ttlForClass(c)`) to get an `expiresAt` instant. Special-category facts always resolve to the shorter
 * duration (never longer than, never equal to, ordinary — Inv 9).
 */
export function ttlForClass(factClass: FactClass): number {
  const days = factClass === "special" ? SPECIAL_TTL_DAYS : ORDINARY_TTL_DAYS;
  return days * DAY_MS;
}

// Mirrors service.ts's RECALL_LIMIT rationale: the vector port has no native "list all" op, so an
// empty-text query ties every record at score 0 and returns them in stable id order up to `k` — exactly
// "give me every record in this namespace" for the modest per-subject fact counts this system deals in.
const SWEEP_QUERY_LIMIT = 500;

export interface RetentionDeps {
  vector: VectorPort;
  /** The RuntimeStatePort's audit surface (ADR-0015 Inv 6) — reused as-is, no new audit mechanism. */
  audit: RuntimeStatePort;
}

/**
 * Deletes every already-expired record, per subject, under `tenantId` — the reclamation half of Inv 4
 * (TTL-on-read in service.ts's `recall` is the correctness half: a stale fact is never SERVED even
 * before a sweep runs; this actually frees the storage). Emits one `ttl_sweep` audit per subject that
 * had something deleted; a subject with nothing expired triggers no vector call and no audit (nothing
 * happened — Inv 6 requires no SILENT action, not an audit for doing nothing). Returns the total number
 * of records deleted across all subjects.
 */
export async function sweepExpired(
  deps: RetentionDeps,
  tenantId: string,
  subjects: string[],
  now: Date = new Date(),
): Promise<number> {
  const nowMs = now.getTime();
  let totalDeleted = 0;

  for (const anonId of subjects) {
    const namespace = subjectNamespace(tenantId, anonId);
    const matches = await deps.vector.query(namespace, { text: "", k: SWEEP_QUERY_LIMIT });

    const expiredIds = matches
      .filter((match) => {
        const meta = match.metadata as Partial<FactMetadata> | undefined;
        return meta?.expiresAt !== undefined && new Date(meta.expiresAt).getTime() <= nowMs;
      })
      .map((match) => match.id);

    if (expiredIds.length === 0) continue;

    await deps.vector.deleteById(namespace, expiredIds);
    await deps.audit.audit(
      { tenantId },
      buildMemoryAudit({ action: "ttl_sweep", tenantId, anonId, count: expiredIds.length }),
    );
    totalDeleted += expiredIds.length;
  }

  return totalDeleted;
}
