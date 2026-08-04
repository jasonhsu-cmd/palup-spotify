import type { RuntimeStatePort, VectorMatch, VectorPort } from "@palup/platform-ports";
import { subjectNamespace } from "./identity.js";
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

// Mirrors service.ts's RECALL_LIMIT / retention.ts's SWEEP_QUERY_LIMIT rationale: an empty-text query
// against the vector port returns every record in the namespace (tie-broken by id), which is exactly
// "give me everything for this subject" for the modest per-subject fact counts this system deals in.
const QUERY_LIMIT = 500;

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
}

/** Identifies one subject (a guest anon id, or an account id post sign-up merge) under one tenant. */
export interface SubjectRef {
  tenantId: string;
  anonId: string;
}

function classOf(match: VectorMatch): FactClass | undefined {
  return (match.metadata as Partial<FactMetadata> | undefined)?.class;
}

/**
 * Enumerate a subject's records for a data-RIGHTS purge, COMPLETELY or not at all. An empty-text query
 * returns up to `k` records, so getting exactly `k` back means there MAY be more we can't see — for a
 * GDPR withdrawal/erasure that must FAIL CLOSED (the caller escalates to a full deleteNamespace or a
 * port-level batch delete) rather than delete a partial set and audit it as a complete purge. Realistic
 * per-subject fact counts are far below the cap; this guard exists so incompleteness can never be
 * SILENT (Inv 5: erasure must be complete, never silently partial).
 */
async function enumerateSubjectOrFail(deps: ErasureDeps, namespace: string): Promise<VectorMatch[]> {
  const matches = await deps.vector.query(namespace, { text: "", k: QUERY_LIMIT });
  if (matches.length >= QUERY_LIMIT) {
    throw new Error(
      `withdraw: subject has >= ${QUERY_LIMIT} records; one query cannot enumerate them completely, so a ` +
        `complete purge can't be guaranteed — escalate to deleteNamespace or a port batch delete rather ` +
        `than a silently partial purge (ADR-0015 Inv 5).`,
    );
  }
  return matches;
}

/**
 * Full, audited right-to-erasure for one subject (ADR-0015 Inv 5): deletes their ENTIRE namespace —
 * every ordinary and special-category fact — via the vector port's `deleteNamespace`. Under Option B a
 * namespace already IS one subject (`${tenantId}::${anonId}`, identity.ts), so this is inherently a
 * single-subject erasure and never touches another subject's data (see `eraseTenant` below for the
 * whole-tenant case, which Option B does not yet support).
 */
export async function eraseSubject(deps: ErasureDeps, ctx: SubjectRef): Promise<void> {
  await deps.vector.deleteNamespace(subjectNamespace(ctx.tenantId, ctx.anonId));
  await deps.audit.audit(
    { tenantId: ctx.tenantId },
    buildMemoryAudit({ action: "erase.subject", tenantId: ctx.tenantId, anonId: ctx.anonId, hmacKey: deps.hmacKey }),
  );
}

/**
 * Consent-2 (special-category / Art. 9) withdrawal (ADR-0015 "Withdrawal is symmetric" — withdrawing
 * Consent 2 PURGES the sensitive fact). Erasure-first: deletes only the records classified `"special"`
 * for this subject and LEAVES ordinary facts untouched — Consent 2 is independent of Consent 1 (Inv 9),
 * so a shopper withdrawing the health tier alone must keep any ordinary memory they still consent to.
 */
export async function withdrawConsent2(deps: ErasureDeps, ctx: SubjectRef): Promise<{ purged: number }> {
  const namespace = subjectNamespace(ctx.tenantId, ctx.anonId);
  const matches = await enumerateSubjectOrFail(deps, namespace);
  const specialIds = matches.filter((m) => classOf(m) === "special").map((m) => m.id);

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
 */
export async function withdrawConsent1(deps: ErasureDeps, ctx: SubjectRef): Promise<{ purged: number }> {
  const namespace = subjectNamespace(ctx.tenantId, ctx.anonId);
  const matches = await enumerateSubjectOrFail(deps, namespace);
  const ordinaryIds = matches.filter((m) => classOf(m) === "ordinary").map((m) => m.id);

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
