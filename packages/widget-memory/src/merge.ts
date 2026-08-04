import type { RuntimeStatePort, VectorPort, VectorRecord } from "@palup/platform-ports";
import { subjectNamespace, accountSubjectId } from "./identity.js";
import { buildMemoryAudit } from "./audit.js";
import type { MemoryConsent } from "./consent.js";
import type { FactMetadata } from "./types.js";

// ADR-0015 Tier 2 (Decision, "Signed-up" bullet + "The build" step 5) + Invariant 9: on sign-up/login,
// migrate the guest anon-id's facts into the account namespace — a ONE-TIME, AUDITED migration. Special-
// category facts are NEVER auto-folded into the account's sign-up ToS consent: they migrate ONLY when
// the shopper has separately granted Consent 2 for the account too; otherwise they are DROPPED rather
// than silently promoted onto a weaker consent basis.

// Mirrors service.ts's RECALL_LIMIT / retention.ts's SWEEP_QUERY_LIMIT rationale: an empty-text query
// against the vector port returns every record in the namespace, which is exactly "give me everything
// for this subject" for the modest per-subject fact counts this system deals in.
const QUERY_LIMIT = 500;

export interface MergeDeps {
  vector: VectorPort;
  /** The RuntimeStatePort's audit surface (ADR-0015 Inv 6) — reused as-is, no new audit mechanism. */
  audit: RuntimeStatePort;
  /** MEDIUM finding (security-review remediation, PR #152) — keyed-HMAC key for the audit `subjectRef`
   * (audit.ts's own doc comment); see ErasureDeps/RetentionDeps/MemoryServiceDeps for the same field.
   * Optional here ONLY so this module (which has no production caller yet — B12) can be unit-tested
   * without one; `mergeGuestIntoAccount` itself throws outside a test runner when it's omitted (N6,
   * security review round 3, LOW/latent) — see its own doc comment. */
  hmacKey?: string;
}

export interface MergeCtx {
  tenantId: string;
  anonId: string;
  accountId: string;
  /** Consent 2 status FOR THE ACCOUNT. Only `"in"` lets special-category facts migrate (Inv 9); any
   * other value (`"out"`/`"unknown"`) drops them — never promoted under sign-up ToS alone. */
  consent2: MemoryConsent;
}

/**
 * One-time, audited guest -> account migration (ADR-0015 Tier 2). Ordinary facts always migrate;
 * special-category facts migrate ONLY when `ctx.consent2 === "in"` (Inv 9). The anon namespace is fully
 * erased afterward via `deleteNamespace`, so calling this again for the same `anonId` is a provable
 * no-op — nothing left to read, nothing left to erase, nothing gets double-counted in the account.
 */
export async function mergeGuestIntoAccount(deps: MergeDeps, ctx: MergeCtx): Promise<{ merged: number }> {
  // N6 (security review round 3, LOW/latent) — this module has NO production caller today (B12 is the
  // still-unbuilt wiring); `deps.hmacKey` stays `?:string` on `MergeDeps` above purely so unit tests can
  // construct it without one. But every audit this function writes targets an `acct:` subject
  // (`accountSubjectId`, identity.ts) — audit.ts's own rule (mirrors server.ts's `AUDIT_HMAC_SECRET`
  // pattern, and the SAME rule ErasureDeps/RetentionDeps/MemoryServiceDeps enforce by always being wired
  // with a real key in production) is that a low-entropy `acct:` subject's audit ref MUST be a keyed
  // HMAC, never a bare hash, or it is brute-forceable. Silently degrading here would be easy to miss the
  // day B12 finally wires a real caller. Fail LOUDLY outside a test runner instead — the same "no
  // config-only silent gap" idiom `flag.ts`/`service.ts` already use for their own test-only seams.
  // Read PER CALL (not hoisted to module scope) so a test can flip `process.env.VITEST`/`NODE_ENV` and
  // observe the guard fire, exactly like `flag.ts`'s/`service.ts`'s own equivalent checks.
  const underTest = process.env.VITEST === "true" || process.env.NODE_ENV === "test";
  if (!deps.hmacKey && !underTest) {
    throw new Error(
      "mergeGuestIntoAccount: hmacKey is required outside a test runner — this merge's audit subjectRef " +
        "targets an acct: subject (identity.ts accountSubjectId), which per audit.ts's own rule must be a " +
        "KEYED HMAC, never a bare hash (N6, security review round 3). Pass the same key server.ts's " +
        "AUDIT_HMAC_SECRET already uses for every other memory-audit call site.",
    );
  }
  const anonNamespace = subjectNamespace(ctx.tenantId, ctx.anonId);
  const accountNamespace = subjectNamespace(ctx.tenantId, accountSubjectId(ctx.accountId));

  const matches = await deps.vector.query(anonNamespace, { text: "", k: QUERY_LIMIT });

  const toMigrate: VectorRecord[] = [];
  for (const match of matches) {
    const meta = match.metadata as Partial<FactMetadata> | undefined;
    if (meta?.class === "special" && ctx.consent2 !== "in") continue; // Inv 9 — dropped, never promoted
    toMigrate.push({ id: match.id, text: meta?.text, metadata: match.metadata });
  }

  if (toMigrate.length > 0) await deps.vector.upsert(accountNamespace, toMigrate);
  await deps.vector.deleteNamespace(anonNamespace); // one-time migration — anon namespace is now empty

  await deps.audit.audit(
    { tenantId: ctx.tenantId },
    buildMemoryAudit({ action: "merge", tenantId: ctx.tenantId, anonId: ctx.anonId, count: toMigrate.length, hmacKey: deps.hmacKey }),
  );

  return { merged: toMigrate.length };
}
