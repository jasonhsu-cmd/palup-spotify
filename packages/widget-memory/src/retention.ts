import type { RuntimeStatePort, VectorPort } from "@palup/platform-ports";
import { subjectNamespace, floorNamespace } from "./identity.js";
import { buildMemoryAudit, subjectRef } from "./audit.js";
import type { FactClass } from "./classifier.js";
import type { FactMetadata } from "./types.js";
import { listSubjects, retireSubject } from "./subject-index.js";

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

// semantic-memory-v1 foundation, T2 — RULING: page through a subject's ENTIRE record set via
// `VectorPort.list` (bounded keyset enumerate) rather than a single capped `query(ns,{text:"",k:500})` —
// the old idiom both truncated at 500 (so a subject with >500 facts had its true expired count
// undercounted) AND throws outright on a text-query-only-unsupported ANN adapter (pgvector). `SWEEP_PAGE_LIMIT`
// is just the per-page size; `MAX_SWEEP_PAGES` is a generous defensive ceiling (SWEEP_PAGE_LIMIT *
// MAX_SWEEP_PAGES = 1,000,000 records) against a pathological/corrupt namespace, never a normal-path
// limit — exceeding it throws rather than silently truncating the sweep.
const SWEEP_PAGE_LIMIT = 500;
const MAX_SWEEP_PAGES = 2000;

/** Thrown by `sweepExpired` when one subject's namespace isn't exhausted within `MAX_SWEEP_PAGES` pages —
 *  a backstop so a pathologically large/corrupt namespace can never be silently under-swept. */
export class SweepPageCeilingExceeded extends Error {
  constructor(namespace: string) {
    super(
      `sweepExpired: ${namespace} was not exhausted within MAX_SWEEP_PAGES=${MAX_SWEEP_PAGES} pages ` +
        `(SWEEP_PAGE_LIMIT=${SWEEP_PAGE_LIMIT}) — refusing to sweep a partial enumeration`,
    );
    this.name = "SweepPageCeilingExceeded";
  }
}

/**
 * Pages `namespace` to exhaustion via `VectorPort.list` (T2 pattern — see the module-level note above)
 * and returns the ids of every record whose `expiresAt` is already `<= nowMs`. Shared by `sweepExpired`
 * for BOTH a subject's main namespace and its `floorNamespace` (#125 — safety-floor/special-category
 * facts live there now, so their TTL expiry must be swept from the same place `remember()` writes them,
 * not from the main namespace where they no longer live).
 */
async function enumerateExpiredIds(vector: VectorPort, namespace: string, nowMs: number): Promise<string[]> {
  const expiredIds: string[] = [];
  let after: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= MAX_SWEEP_PAGES) throw new SweepPageCeilingExceeded(namespace);
    const batch = await vector.list(namespace, { limit: SWEEP_PAGE_LIMIT, after });
    // INVARIANT (security review, Finding 10, NOTE): a record with NO `expiresAt` at all is structurally
    // UNREACHABLE by this sweep (and by recall's renewal, service.ts) — it would be retained and served
    // forever. Nothing in this codebase writes such a record today (service.ts's `remember` always
    // stamps `expiresAt`), so this is latent, not live. If any future non-widget-memory writer ever
    // touches `vp_records` without stamping `expiresAt`, that record silently escapes Inv 4 entirely —
    // this filter has no floor for metadata-less rows.
    for (const item of batch) {
      const meta = item.metadata as Partial<FactMetadata> | undefined;
      if (meta?.expiresAt !== undefined && new Date(meta.expiresAt).getTime() <= nowMs) expiredIds.push(item.id);
    }
    if (batch.length < SWEEP_PAGE_LIMIT) break; // short page — namespace exhausted
    after = batch[batch.length - 1]!.id;
  }
  return expiredIds;
}

export interface RetentionDeps {
  vector: VectorPort;
  /** The RuntimeStatePort's audit surface (ADR-0015 Inv 6) — reused as-is, no new audit mechanism. */
  audit: RuntimeStatePort;
  /** MEDIUM finding (security-review remediation, PR #152) — keyed-HMAC key for the audit `subjectRef`
   * (audit.ts's own doc comment). Optional: omitted falls back to a plain sha256, safe only for a
   * high-entropy guest anon id — required for an `acct:` subject's ref to be genuinely pseudonymous
   * rather than brute-forceable. Mirrors server.ts's `AUDIT_HMAC_SECRET`. */
  hmacKey?: string;
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
 * ONLY the subject already being served that turn (`[memorySubject]`, a one-element `subjects` array — the server-derived subject, not the raw client `signals.anonId`)
 * — never an enumeration of every subject for the tenant. That narrow scope is deliberate: enumerating
 * "every subject for the request's tenant" has no existing bounded way to do it (the `memory_consent` KV
 * collection — state-postgres's `runtime-consent-store.ts` — is the only per-subject index and has no
 * `list()` caller today) without itself becoming an unbounded scan on the serving path (the same class
 * of hot-path risk state-postgres's shared-pool fix addresses for connections).
 *
 * SCOPE: this closes reclamation for any subject who RETURNS — their own next /chat turn sweeps their own
 * expired facts. It does not, and structurally cannot, reach a subject who never comes back, because it
 * only ever visits the subject being served.
 *
 * THAT GAP IS NOW CLOSED BY `sweepAllSubjects` BELOW (B4, 2026-08-05), which enumerates the tenant's
 * subject index (subject-index.ts) and is driven by a scheduled job
 * (widget-backend/src/jobs/retention-sweep.ts, `pnpm sweep`). An earlier revision of this comment said
 * that broader sweep "is still a go-live item" and speculated it would need an admin HTTP endpoint; it
 * shipped as a JOB instead, deliberately — a scheduled process needs no new network-reachable
 * destructive endpoint and no new shared secret to guard one. TTL-on-read (service.ts `recall`) remains
 * the unconditional serving guarantee either way: an expired fact is never SERVED even if no sweep has
 * run yet.
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
    // #125 — special-category facts now live in the dedicated per-subject FLOOR namespace (identity.ts),
    // not the main subject namespace, so their TTL expiry must be swept from THERE too: sweeping only
    // `namespace` would let an expired special fact sit in the floor namespace forever, never physically
    // reclaimed (TTL-on-read in service.ts's `recall` still hides it from being SERVED, but the storage
    // itself would never be freed and `sweepAllSubjects`'s retire check below would never see this
    // subject's floor namespace go empty).
    const floorNs = floorNamespace(tenantId, anonId);

    // Page each namespace to exhaustion (T2) — see `enumerateExpiredIds` above.
    const expiredMain = await enumerateExpiredIds(deps.vector, namespace, nowMs);
    const expiredFloor = await enumerateExpiredIds(deps.vector, floorNs, nowMs);
    const combinedCount = expiredMain.length + expiredFloor.length;

    if (combinedCount === 0) continue;

    // ADR-0015 Inv 6 / NN#5 (security review, Finding 1 — HIGH: "a destructive delete can land
    // unaudited"). AUDIT BEFORE DELETE, never the reverse, so "deleted but unaudited" is structurally
    // unreachable: if the audit write itself throws, we skip BOTH deletes for THIS subject entirely
    // (caught below) rather than risk an unaudited destructive action. `audit` and `vector` are
    // separate ports (ADR-0001 — a VectorPort adapter need not even be Postgres), so this ordering,
    // not a cross-port DB transaction, is what makes the guarantee hold portably. One COMBINED audit per
    // subject (main + floor counted together, `combinedCount`) rather than two — a subject either had
    // something expired somewhere and that's audited once, or it didn't and nothing is written. The
    // accepted, narrower residual is the mirror case: audited, but a physical delete then fails — a stale
    // record simply stays undeleted (TTL-on-read in service.ts `recall` still hides it from ever being
    // served, so nothing is served past its TTL) rather than an invisible destructive action, and that
    // failure is never silently swallowed — it is surfaced below as a PII-free, operator-visible signal
    // (tenantId + hashed subjectRef + attempted count + the error's class only — never fact text or the
    // raw anonId).
    const ref = subjectRef(tenantId, anonId, deps.hmacKey);
    try {
      await deps.audit.audit(
        { tenantId },
        buildMemoryAudit({ action: "ttl_sweep", tenantId, anonId, count: combinedCount, hmacKey: deps.hmacKey }),
      );
    } catch (e) {
      console.error(
        `[retention] ttl_sweep audit failed tenant=${tenantId} subjectRef=${ref} attemptedCount=${combinedCount} error=${errorClassName(e)} — skipping delete for this subject (never delete without its audit)`,
      );
      continue;
    }
    if (expiredMain.length > 0) {
      try {
        await deps.vector.deleteById(namespace, expiredMain);
        totalDeleted += expiredMain.length;
      } catch (e) {
        console.error(
          `[retention] ttl_sweep delete failed tenant=${tenantId} subjectRef=${ref} namespace=main attemptedCount=${expiredMain.length} error=${errorClassName(e)} — audited as decided, NOT physically deleted; TTL-on-read still hides it from serving`,
        );
      }
    }
    if (expiredFloor.length > 0) {
      try {
        await deps.vector.deleteById(floorNs, expiredFloor);
        totalDeleted += expiredFloor.length;
      } catch (e) {
        console.error(
          `[retention] ttl_sweep delete failed tenant=${tenantId} subjectRef=${ref} namespace=floor attemptedCount=${expiredFloor.length} error=${errorClassName(e)} — audited as decided, NOT physically deleted; TTL-on-read still hides it from serving`,
        );
      }
    }
  }

  return totalDeleted;
}

export interface SweepAllResult {
  /** Subjects actually visited this run (≤ `maxSubjects`). */
  visited: number;
  /** Records physically deleted across those subjects. */
  deleted: number;
  /** Index entries dropped because the subject's namespace is now empty. */
  retired: number;
  /** Subjects whose sweep threw and were skipped. The run continues past them. */
  failed: number;
  /** Indexed subjects NOT visited because `maxSubjects` cut the run short. Non-zero means work was
   * deliberately left behind — surfaced so a caller can log it or schedule another pass, rather than a
   * bounded run silently reading as "everything is reclaimed". */
  remaining: number;
}

/** Default ceiling on subjects per run, so one invocation cannot become an unbounded scan. A scheduler
 * simply runs it again; `remaining` says whether it needs to. */
const DEFAULT_MAX_SUBJECTS = 500;

/**
 * B4 — the SCHEDULED half of Inv 4 retention, and the part the per-turn sweep structurally cannot do.
 *
 * `sweepExpired` above reclaims only the subject being served on a live /chat turn, so a shopper who
 * RETURNS cleans up after themselves while one who never comes back is never reclaimed at all. This
 * enumerates the tenant's subject index (subject-index.ts — built from actual fact writes, because
 * `VectorPort` cannot list namespaces and the consent KV misses every "unknown"-consent shopper) and
 * sweeps each one, retiring subjects whose storage is now empty.
 *
 * NOT AN ERASURE PATH. The only predicate remains EXPIRY (`sweepExpired`): a live fact is untouched, a
 * consent-withdrawn-but-unexpired fact is untouched (that asymmetry is unchanged and still documented on
 * `sweepExpired` itself). This reclaims storage; it never decides what may be remembered.
 *
 * WHAT THIS DOES NOT CHECK — deliberately, and it matters. There is no kill-switch check here, because
 * `RuntimeStatePort`'s kill registry lives in @palup/state-postgres and this package does not depend on
 * it (ADR-0001 layering). The CALLER must check the kill switch before invoking this per tenant — the
 * shipped job (widget-backend/src/jobs/retention-sweep.ts) does, and its test covers it. A future caller
 * that forgets would run a mass delete against a halted tenant.
 *
 * Resilient by design: one subject's failure is counted and stepped over, never aborting the run, so a
 * single corrupt namespace cannot indefinitely block reclamation for every other subject.
 */
export async function sweepAllSubjects(
  deps: RetentionDeps,
  tenantId: string,
  opts?: { maxSubjects?: number; now?: Date },
): Promise<SweepAllResult> {
  const now = opts?.now ?? new Date();
  const max = opts?.maxSubjects ?? DEFAULT_MAX_SUBJECTS;
  const all = await listSubjects(deps.audit, tenantId);
  const batch = all.slice(0, max);

  const result: SweepAllResult = { visited: 0, deleted: 0, retired: 0, failed: 0, remaining: all.length - batch.length };

  for (const entry of batch) {
    result.visited++;
    try {
      result.deleted += await sweepExpired(deps, tenantId, [entry.subject], now);
      // Retire only on a CONFIRMED-empty namespace, re-read after the delete — never inferred from the
      // delete count, which would wrongly retire a subject whose only records happened to be expired
      // while a concurrent write was landing.
      //
      // #125 — a subject's facts can now live in TWO namespaces (the main one and its `floorNamespace`
      // for safety-floor/special-category rows), so retirement requires BOTH to be confirmed empty.
      // Checking only the main namespace would wrongly retire a subject that still holds live floor
      // rows (orphaning them — the scheduled sweep would stop visiting a subject the index no longer
      // lists, even though special-category facts remain in storage); checking only the floor namespace
      // would symmetrically block retirement forever for an ordinary-only subject that never wrote a
      // special fact (its floor namespace is always empty, so that alone must never gate anything).
      const [remainingMain, remainingFloor] = await Promise.all([
        deps.vector.list(subjectNamespace(tenantId, entry.subject), { limit: 1 }),
        deps.vector.list(floorNamespace(tenantId, entry.subject), { limit: 1 }),
      ]);
      if (remainingMain.length === 0 && remainingFloor.length === 0) {
        await retireSubject(deps.audit, { tenantId, subject: entry.subject });
        result.retired++;
      }
    } catch (e) {
      result.failed++;
      console.error(
        `[retention] sweepAllSubjects: subject skipped tenant=${tenantId} subjectRef=${subjectRef(tenantId, entry.subject, deps.hmacKey)} error=${errorClassName(e)} — continuing with the rest`,
      );
    }
  }

  return result;
}
