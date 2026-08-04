import type { RuntimeStatePort, VectorPort } from "@palup/platform-ports";
import { subjectNamespace } from "./identity.js";
import { buildMemoryAudit, subjectRef } from "./audit.js";
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

/** The error's constructor name only (never `.message`) — an operator-visible failure signal must stay
 * PII-free even in the unlikely case an adapter's error message happened to echo back call arguments. */
function errorClassName(e: unknown): string {
  return e instanceof Error ? e.constructor.name : typeof e;
}

/**
 * Deletes every already-expired record, per subject, under `tenantId` — the reclamation half of Inv 4
 * (TTL-on-read in service.ts's `recall` is the correctness half: a stale fact is never SERVED even
 * before a sweep runs; this actually frees the storage). Emits one `ttl_sweep` audit per subject that
 * had something DECIDED for deletion (the audit is written BEFORE the physical delete — see the
 * ordering note below — so it records the sweep's decision even in the rare case the delete itself
 * then fails); a subject with nothing expired triggers no vector call and no audit (nothing happened —
 * Inv 6 requires no SILENT action, not an audit for doing nothing). Returns the total number of records
 * ACTUALLY deleted (not merely decided) across all subjects.
 *
 * PRODUCTION CALLER (partially closes the prior "no production caller" go-live gap, security review,
 * MEDIUM): widget-backend/server.ts's POST /chat handler now calls this OPPORTUNISTICALLY, scoped to
 * ONLY the subject already being served that turn (`[signals.anonId]`, a one-element `subjects` array)
 * — never an enumeration of every subject for the tenant. That narrow scope is deliberate: enumerating
 * "every subject for the request's tenant" has no existing bounded way to do it (the `memory_consent` KV
 * collection — state-postgres's `runtime-consent-store.ts` — is the only per-subject index and has no
 * `list()` caller today) without itself becoming an unbounded scan on the serving path (the same class
 * of hot-path risk state-postgres's shared-pool fix addresses for connections).
 *
 * REMAINING TRADE-OFF: this closes reclamation for any subject who returns (their own next /chat turn
 * sweeps their own expired facts before storage would otherwise grow unboundedly on the durable Postgres
 * VectorPort adapter — before that adapter existed, a process restart wiped the in-memory store,
 * bounding growth incidentally). It does NOT reclaim storage for a subject who never returns — TTL-on-
 * read (service.ts `recall`) still means an expired fact for such a subject is never SERVED (Inv 4's
 * serving guarantee holds unconditionally), but it is not physically deleted until either they return or
 * a separate scheduled job (e.g. Cloud Scheduler → an admin-only endpoint enumerating each tenant's known
 * subjects) or a DB-side expiry mechanism is added — that broader periodic sweep is still a go-live item,
 * now narrower in scope (only "gone forever, never returns" subjects, not every subject).
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

    // INVARIANT (security review, Finding 10, NOTE): a record with NO `expiresAt` at all is structurally
    // UNREACHABLE by this sweep (and by recall's renewal, service.ts) — it would be retained and served
    // forever. Nothing in this codebase writes such a record today (service.ts's `remember` always
    // stamps `expiresAt`), so this is latent, not live. If any future non-widget-memory writer ever
    // touches `vp_records` without stamping `expiresAt`, that record silently escapes Inv 4 entirely —
    // this filter has no floor for metadata-less rows.
    const expiredIds = matches
      .filter((match) => {
        const meta = match.metadata as Partial<FactMetadata> | undefined;
        return meta?.expiresAt !== undefined && new Date(meta.expiresAt).getTime() <= nowMs;
      })
      .map((match) => match.id);

    if (expiredIds.length === 0) continue;

    // ADR-0015 Inv 6 / NN#5 (security review, Finding 1 — HIGH: "a destructive delete can land
    // unaudited"). AUDIT BEFORE DELETE, never the reverse, so "deleted but unaudited" is structurally
    // unreachable: if the audit write itself throws, we skip the delete for THIS subject entirely
    // (caught below) rather than risk an unaudited destructive action. `audit` and `vector` are
    // separate ports (ADR-0001 — a VectorPort adapter need not even be Postgres), so this ordering,
    // not a cross-port DB transaction, is what makes the guarantee hold portably. The accepted, narrower
    // residual is the mirror case: audited, but the physical delete then fails — a stale record simply
    // stays undeleted (TTL-on-read in service.ts `recall` still hides it from ever being served, so
    // nothing is served past its TTL) rather than an invisible destructive action, and that failure is
    // never silently swallowed — it is surfaced below as a PII-free, operator-visible signal (tenantId +
    // hashed subjectRef + attempted count + the error's class only — never fact text or the raw anonId).
    const ref = subjectRef(tenantId, anonId);
    try {
      await deps.audit.audit(
        { tenantId },
        buildMemoryAudit({ action: "ttl_sweep", tenantId, anonId, count: expiredIds.length }),
      );
    } catch (e) {
      console.error(
        `[retention] ttl_sweep audit failed tenant=${tenantId} subjectRef=${ref} attemptedCount=${expiredIds.length} error=${errorClassName(e)} — skipping delete for this subject (never delete without its audit)`,
      );
      continue;
    }
    try {
      await deps.vector.deleteById(namespace, expiredIds);
      totalDeleted += expiredIds.length;
    } catch (e) {
      console.error(
        `[retention] ttl_sweep delete failed tenant=${tenantId} subjectRef=${ref} attemptedCount=${expiredIds.length} error=${errorClassName(e)} — audited as decided, NOT physically deleted; TTL-on-read still hides it from serving`,
      );
    }
  }

  return totalDeleted;
}
