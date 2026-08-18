import type { RuntimeStatePort, VectorListItem, VectorPort } from "@palup/platform-ports";
import { subjectNamespace, floorNamespace } from "./identity.js";
import { buildMemoryAudit } from "./audit.js";
import type { FactClass } from "./classifier.js";
import type { FactMetadata } from "./types.js";

// ADR-0015 Invariant 5 (right-to-erasure, audited) + the Consent UX "Withdrawal is symmetric" rule:
// withdrawing Consent 2 PURGES the special-category fact (erasure-first); withdrawing Consent 1 stops +
// erases ordinary facts, leaving any separately-consented special fact untouched (Consent 2 is
// independent of Consent 1 — Inv 9). Every function here is a data-RIGHTS action taken by (or on behalf
// of) the shopper — unlike retention.ts's background `sweepExpired`, each call is audited
// UNCONDITIONALLY, even when there was nothing to purge, because the withdrawal/erasure request is
// itself the meaningful event, not just its side effect.

// semantic-memory-v1 foundation, T2 — RULING: paginate to exhaustion via VectorPort's `list`, rather than
// a single capped `query(ns,{text:"",k:500})`. Completeness (Inv 5: erasure must be complete, never
// silently partial) is now guaranteed by walking every page to a short (< PAGE_LIMIT) terminator, not by
// refusing to enumerate past a cap. `PAGE_LIMIT` is just the per-page size — it bounds one round-trip, not
// how many records total can be enumerated.
const PAGE_LIMIT = 500;

// A HIGH safety ceiling on pages walked per enumeration: PAGE_LIMIT * MAX_PAGES = 1,000,000 records —
// several orders of magnitude past any realistic per-subject fact count this system deals in. This is a
// backstop against a pathological/corrupt namespace, NOT a normal-path limit: exceeding it never happens
// for a real shopper. If it's ever exceeded on a WITHDRAWAL path, the caller escalates to a full
// `deleteNamespace` (the withdrawal already deletes something; a defensive full-erase of the whole
// subject is a safe, never-worse outcome) rather than loop unbounded or silently truncate the purge.
const MAX_PAGES = 2000;

// MEMORY-GO-LIVE-CHECKLIST.md §E1 (raw-turn PII in Pub/Sub) — the async memory-write queue's erasure
// path does not reach Pub/Sub, so a withdrawal/erasure request during the queue's retention window would
// otherwise leave an in-flight or DLQ'd raw turn to be written AFTER the shopper asked to be forgotten.
// Every withdrawal/erasure entry point below writes a subject-level TOMBSTONE here; the queue consumer
// (widget-backend's pubsub-push-memory.ts) checks it before calling `remember` and drops (ack, no write)
// any message published at or before the tombstone's `erasedAtMs`.
export const ERASURE_TOMBSTONE_COLLECTION = "mem:erasure-tombstone";
/** Subject-level (not per-class) — one tombstone covers both the main and floor namespaces for this
 *  anonId, since a message dropped by the queue was never written to either. */
export function tombstoneKey(anonId: string): string {
  return anonId;
}
// 48h — must exceed the max queue message lifetime (Pub/Sub `message_retention_duration`, currently 1h
// per infra/terraform/pubsub-memory.tf) so the tombstone can never expire while a message it must catch
// is still deliverable.
export const ERASURE_TOMBSTONE_TTL_SECONDS = 172_800;

/** Thrown by `enumerateSubject` when a namespace isn't exhausted within `MAX_PAGES` pages. Carries the
 *  partial page-walk so a WITHDRAWAL caller can escalate deliberately (see `withdrawConsent1`/
 *  `withdrawConsent2`) rather than resolve with a silently incomplete purge. */
export class PageCeilingExceeded extends Error {
  constructor(
    public readonly namespace: string,
    public readonly partial: VectorListItem[],
  ) {
    super(
      `enumerateSubject: ${namespace} was not exhausted within MAX_PAGES=${MAX_PAGES} pages ` +
        `(PAGE_LIMIT=${PAGE_LIMIT}) — refusing to resolve with a partial enumeration (ADR-0015 Inv 5)`,
    );
    this.name = "PageCeilingExceeded";
  }
}

/**
 * Walk `namespace` to exhaustion via `VectorPort.list` (ascending id, `after` an exclusive lower bound —
 * see list's own contract), returning EVERY record regardless of how many pages that takes. A page
 * shorter than `PAGE_LIMIT` is the exhaustion terminator (mirrors the ANN/in-memory KEYSET-AT-SCALE
 * contract tests). Throws `PageCeilingExceeded` rather than ever silently truncating.
 */
async function enumerateSubject(deps: ErasureDeps, namespace: string): Promise<VectorListItem[]> {
  const out: VectorListItem[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await deps.vector.list(namespace, { limit: PAGE_LIMIT, after });
    out.push(...batch);
    if (batch.length < PAGE_LIMIT) return out; // short page — namespace exhausted
    after = batch[batch.length - 1]!.id;
  }
  throw new PageCeilingExceeded(namespace, out);
}

export interface ErasureDeps {
  vector: VectorPort;
  /** The RuntimeStatePort's audit surface (ADR-0015 Inv 6) — reused as-is, no new audit mechanism. */
  audit: RuntimeStatePort;
  /** MEDIUM finding (security-review remediation, PR #152) — keyed-HMAC key for the audit `subjectRef`
   * (audit.ts). Optional: omitted means the ref falls back to a plain sha256, which is only safe for a
   * high-entropy guest anon id — supply this whenever one is configured (mirrors server.ts's
   * `AUDIT_HMAC_SECRET`), which is required for a low-entropy `acct:` subject's ref to be genuinely
   * pseudonymous rather than brute-forceable. */
  hmacKey?: string;
  /** Testable clock for the erasure tombstone (§E1 above). Defaults to `Date.now`. */
  now?: () => number;
}

/** Identifies one subject (a guest anon id, or an account id post sign-up merge) under one tenant. */
export interface SubjectRef {
  tenantId: string;
  anonId: string;
}

function classOf(item: VectorListItem): FactClass | undefined {
  return (item.metadata as Partial<FactMetadata> | undefined)?.class;
}

/** Writes the §E1 erasure tombstone for one subject. Called by `eraseSubject`, `withdrawConsent1`, AND
 *  `withdrawConsent2` — a class-specific withdrawal (Consent 1 or 2 alone) conservatively ALSO drops any
 *  in-flight write for the whole subject, not just the withdrawn class: the queue message carries a full
 *  turn, not a single fact, so there is no narrower thing to tombstone. This is safe (never worse than
 *  leaving the in-flight write to land) — see this module's header. */
async function writeErasureTombstone(deps: ErasureDeps, ctx: SubjectRef): Promise<void> {
  const nowMs = (deps.now ?? Date.now)();
  await deps.audit.put(
    { tenantId: ctx.tenantId },
    ERASURE_TOMBSTONE_COLLECTION,
    tombstoneKey(ctx.anonId),
    { erasedAtMs: nowMs },
    { ttlSeconds: ERASURE_TOMBSTONE_TTL_SECONDS },
  );
}

/**
 * Full, audited right-to-erasure for one subject (ADR-0015 Inv 5): deletes their ENTIRE namespace —
 * every ordinary and special-category fact — via the vector port's `deleteNamespace`. Under Option B a
 * namespace already IS one subject (`${tenantId}::${anonId}`, identity.ts), so this is inherently a
 * single-subject erasure and never touches another subject's data (see `eraseTenant` below for the
 * whole-tenant case, which Option B does not yet support).
 */
export async function eraseSubject(deps: ErasureDeps, ctx: SubjectRef): Promise<void> {
  // §E1 (security-review MED-1) — write the tombstone FIRST, before any delete: an in-flight queued
  // message for this subject was published before this erasure request (publishedAt < erasedAtMs), so the
  // consumer drops it regardless of when the deletes land — closing the resurrect-between-delete-and-
  // tombstone window (a message consumed after the deletes but before a tombstone-last write would
  // otherwise re-create the just-erased fact, with eraseSubject still returning success). Writing it first
  // is strictly safer: even if a delete below throws, the in-flight protection is already in place.
  await writeErasureTombstone(deps, ctx);
  await deps.vector.deleteNamespace(subjectNamespace(ctx.tenantId, ctx.anonId));
  // #125 — safety-floor rows (special-category facts) now live in a SEPARATE per-subject namespace
  // (identity.ts's `floorNamespace`), so a full subject erasure must delete THIS namespace too — otherwise
  // a "forget me" request would silently leave every floor row behind. `deleteNamespace` on an
  // unknown/empty namespace is a documented no-op (vector-port.ts), so this is safe even for a subject
  // that never wrote a special-category fact at all.
  await deps.vector.deleteNamespace(floorNamespace(ctx.tenantId, ctx.anonId));
  await deps.audit.audit(
    { tenantId: ctx.tenantId },
    buildMemoryAudit({ action: "erase.subject", tenantId: ctx.tenantId, anonId: ctx.anonId, hmacKey: deps.hmacKey }),
  );
}

/**
 * Shared withdrawal enumeration: walks `namespace` to exhaustion via `enumerateSubject` and filters to
 * `factClass`. On the (never-realistic) `PageCeilingExceeded` backstop, a per-class filter can no longer
 * be trusted as complete either — so this escalates to a full `deleteNamespace` for the subject (safe:
 * the withdrawal already deletes something, so a defensive full erase of whatever else is there is never
 * a worse outcome than leaving it), audits the escalation with the partial count it DID manage to walk
 * (a documented LOWER bound, not a "true total" — `PageCeilingExceeded`'s own doc comment), and re-throws
 * so the caller never mistakes this for an ordinary, fully-accounted purge.
 */
async function idsForClassOrEscalate(
  deps: ErasureDeps,
  ctx: SubjectRef,
  namespace: string,
  factClass: FactClass,
): Promise<string[]> {
  let matches: VectorListItem[];
  try {
    matches = await enumerateSubject(deps, namespace);
  } catch (e) {
    if (!(e instanceof PageCeilingExceeded)) throw e;
    await deps.vector.deleteNamespace(namespace);
    await deps.audit.audit(
      { tenantId: ctx.tenantId },
      buildMemoryAudit({
        action: "consent.withdrawn",
        tenantId: ctx.tenantId,
        anonId: ctx.anonId,
        factClass,
        count: e.partial.length, // a LOWER bound only — see PageCeilingExceeded
        hmacKey: deps.hmacKey,
      }),
    );
    throw e;
  }
  return matches.filter((m) => classOf(m) === factClass).map((m) => m.id);
}

/**
 * Consent-2 (special-category / Art. 9) withdrawal (ADR-0015 "Withdrawal is symmetric" — withdrawing
 * Consent 2 PURGES the sensitive fact). Erasure-first: deletes only the records classified `"special"`
 * for this subject and LEAVES ordinary facts untouched — Consent 2 is independent of Consent 1 (Inv 9),
 * so a shopper withdrawing the health tier alone must keep any ordinary memory they still consent to.
 *
 * T2: enumeration now PAGINATES to exhaustion (no more fail-closed-at-500) — a subject with any number of
 * facts is purged completely, and the audited `count` is the TRUE total purged, not a capped estimate.
 */
export async function withdrawConsent2(deps: ErasureDeps, ctx: SubjectRef): Promise<{ purged: number }> {
  // §E1 (security-review MED-1) — tombstone FIRST, before any delete (see eraseSubject).
  await writeErasureTombstone(deps, ctx);
  // #125 — special-category facts now live in the dedicated FLOOR namespace (identity.ts), not the main
  // subject namespace, so this purge must enumerate/delete THERE — the main namespace no longer holds any
  // `class: "special"` row to find (write-side routing in service.ts's `remember()` is unconditional).
  const namespace = floorNamespace(ctx.tenantId, ctx.anonId);
  const specialIds = await idsForClassOrEscalate(deps, ctx, namespace, "special");

  if (specialIds.length > 0) await deps.vector.deleteById(namespace, specialIds);

  await deps.audit.audit(
    { tenantId: ctx.tenantId },
    buildMemoryAudit({
      action: "consent.withdrawn",
      tenantId: ctx.tenantId,
      anonId: ctx.anonId,
      factClass: "special",
      count: specialIds.length,
      hmacKey: deps.hmacKey,
    }),
  );

  return { purged: specialIds.length };
}

/**
 * Consent-1 (ordinary personal-data / Art. 6) withdrawal — "stop + erase ordinary facts". The STOP half
 * is the caller's responsibility: no consent decision is persisted by this package (region + consent1
 * are re-derived from the caller's own record on every `remember` call, service.ts) — the caller simply
 * passes `consent1 !== "in"` from here on. This function performs the ERASE half: purge every
 * `"ordinary"`-classified fact for the subject, leaving any separately-consented special-category fact
 * untouched (Consent 2 is independent — withdrawing Consent 1 must never silently drop a fact the
 * shopper never withdrew consent for).
 *
 * T2: enumeration now PAGINATES to exhaustion (no more fail-closed-at-500) — a subject with any number of
 * facts is purged completely, and the audited `count` is the TRUE total purged, not a capped estimate.
 */
export async function withdrawConsent1(deps: ErasureDeps, ctx: SubjectRef): Promise<{ purged: number }> {
  // §E1 (security-review MED-1) — tombstone FIRST, before any delete (see eraseSubject).
  await writeErasureTombstone(deps, ctx);
  const namespace = subjectNamespace(ctx.tenantId, ctx.anonId);
  const ordinaryIds = await idsForClassOrEscalate(deps, ctx, namespace, "ordinary");

  if (ordinaryIds.length > 0) await deps.vector.deleteById(namespace, ordinaryIds);

  await deps.audit.audit(
    { tenantId: ctx.tenantId },
    buildMemoryAudit({
      action: "consent.withdrawn",
      tenantId: ctx.tenantId,
      anonId: ctx.anonId,
      factClass: "ordinary",
      count: ordinaryIds.length,
      hmacKey: deps.hmacKey,
    }),
  );

  return { purged: ordinaryIds.length };
}

/**
 * KNOWN DEFERRED GAP (Option B): there is no vector-port call that erases "every subject under this
 * tenant" the way `deleteNamespace` erases one subject today, because Option B keys the port by
 * `${tenantId}::${anonId}` PER SUBJECT (identity.ts) rather than by tenant alone — the port has no
 * `listNamespaces`/`deleteByPrefix`, and this package keeps no durable index of every anonId/accountId
 * ever seen for a tenant. A real whole-tenant erasure needs either a VectorPort extension
 * (deleteByPrefix/deleteNamespaces) or a subject-index, which is a deliberate future decision — not a
 * shortcut to paper over here. THROWS rather than silently no-op-ing, so a caller can never mistake
 * "not implemented" for "already erased" (Inv 5: erasure must be real, never silently skipped).
 */
export function eraseTenant(_deps: ErasureDeps, _tenantId: string): never {
  throw new Error(
    "eraseTenant: NotImplemented — Option B has no whole-tenant erasure yet (per-subject namespaces, " +
      "no subject index / VectorPort deleteByPrefix). See packages/widget-memory/src/erasure.ts and " +
      "docs/adr/0015-cross-visit-memory-eu-consent-gated.md (Inv 2/5).",
  );
}
