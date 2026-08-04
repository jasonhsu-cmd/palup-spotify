import type { RuntimeStatePort, VectorPort } from "@palup/platform-ports";
import { subjectNamespace } from "./identity.js";
import { buildMemoryAudit } from "./audit.js";
import type { FactClass } from "./classifier.js";
import type { FactMetadata } from "./types.js";

// ADR-0015 Invariant 4 (retention TTL, "expiry is enforced, not aspirational", "since last activity") +
// Invariant 9 (special-category stricter storage). The day-counts + the sliding-renewal policy are set by
// the ADR-0015 amendment (named-owner + legal sign-off, 2026-08-04; see the ADR's "Retention TTL — RESOLVED"
// note): both classes retain 30 days as a SLIDING window measured from the shopper's LAST activity, not
// first capture (service.ts `recall` re-stamps a still-consented fact's expiry to `now + ttl` on a return).
// This module is the single source of truth for those day-counts + the renew throttle: service.ts's
// `remember` (TTL-on-write), `recall` (TTL-on-read drops expired + slides the survivors forward, throttled
// + audited), and `sweepExpired` all key off `ttlForClass` here, so they never drift. `sweepExpired`
// is the periodic reclamation half — it deletes what TTL-on-read merely hides — mirroring
// RuntimeStatePort's own `sweepExpired` (expiry enforced on read; sweeping reclaims storage).

const DAY_MS = 24 * 60 * 60 * 1000;

/** Guest/ordinary-fact retention (ADR-0015 Inv 4). Ratified by the ADR-0015 amendment (named owner +
 * legal, 2026-08-04): 30 days, applied as a SLIDING window measured from the shopper's LAST activity — a
 * return visit re-stamps the fact's expiry to `now + ttl` (service.ts `recall`), so 30d of INACTIVITY, not
 * 30d from first capture, is what expires it. */
export const ORDINARY_TTL_DAYS = 30;

/** Special-category (Art. 9) retention (ADR-0015 Inv 9). Ratified by the ADR-0015 amendment (named owner +
 * legal, 2026-08-04): 30 days — EQUAL to ordinary. This AMENDS Inv 9's original "shorter TTL" element to
 * `TTL_special ≤ TTL_ordinary` (special is never retained LONGER than ordinary). Inv 9's OTHER stricter-
 * storage elements (mandatory Consent 2, extra audit, erasure-first) are UNCHANGED — only the shorter-TTL
 * element was amended by legal. Also slides from last activity. */
export const SPECIAL_TTL_DAYS = 30;

/** Sliding-retention throttle (service.ts `recall`): a still-consented fact's expiry is re-stamped on a
 * return at MOST once per this interval, so a burst of same-session recalls neither churns the store nor
 * floods the immutable audit log — each `ttl_renew` audit then marks a genuine return-after-a-gap, not
 * per-turn noise. */
export const RENEW_MIN_GAP_MS = DAY_MS; // 1 day

/**
 * The TTL for a fact of the given sensitivity class, in MILLISECONDS — add to a clock reading (`now +
 * ttlForClass(c)`) to get an `expiresAt` instant. Per the ADR-0015 amendment (2026-08-04) ordinary and
 * special-category retention are equal (30d); Inv 9's retention constraint holds as TTL_special ≤
 * TTL_ordinary (never longer).
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
 *
 * GO-LIVE GAP — NO PRODUCTION CALLER (security review, MEDIUM). Nothing in widget-backend/control-plane
 * calls this function today; the only wired periodic sweep is `RuntimeStatePort.sweepExpired()` for
 * `rs_kv` (server.ts's opportunistic reclamation, ~every RECLAIM_EVERY requests), which does NOT touch
 * `vp_records`. Before the durable Postgres adapter (state-postgres) existed this was low-risk — a
 * process restart wiped the in-memory vector store, bounding growth incidentally; a DURABLE store turns
 * that into UNBOUNDED retention: an expired Art-9 fact is hidden from recall (TTL-on-read) but never
 * actually deleted, so ADR-0015 Inv 4 ("expiry is enforced, not aspirational") is not fully met in
 * practice, and a subject whose namespace grows past `erasure.ts`'s 500-row enumeration cap can have
 * their `withdrawConsent1`/`withdrawConsent2`/erasure permanently fail. This function itself IS safe to
 * call (per-subject, audited, tested) — what's missing is a CALLER: a real deployment needs either (a) a
 * scheduled job (e.g. Cloud Scheduler → an admin-only endpoint) that enumerates each tenant's known
 * subjects (the `memory_consent` KV collection — state-postgres's `runtime-consent-store.ts` — is the
 * only existing per-subject index and would need its own bounded `list()` caller) and calls this per
 * tenant, or (b) a DB-side expiry mechanism. Deliberately NOT wired as an opportunistic per-request call
 * (mirroring server.ts's `rs_kv`/traffic/telemetry reclamation) here: unlike those, there is no existing
 * bounded way to enumerate "every subject for the request's tenant" without itself becoming an unbounded
 * scan on the serving path (the same class of hot-path risk state-postgres's shared-pool fix addresses
 * for connections) — landing that safely is real, separate design work, not a two-line call. Tracked as
 * a go-live item; silence about it is exactly what a prior review flagged, so this comment is that
 * visibility.
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
