import type { RuntimeStatePort, VectorPort, VectorRecord } from "@palup/platform-ports";
import { subjectNamespace, accountSubjectId } from "./identity.js";
import { buildMemoryAudit } from "./audit.js";
import type { MemoryConsent } from "./consent.js";
import type { FactMetadata } from "./types.js";

// ADR-0015 Tier 2 (Decision, "Signed-up" bullet + "The build" step 5) + Invariant 9: on sign-up/login,
// carry the guest anon-id's facts into the account namespace — an AUDITED COPY. Special-category facts
// are NEVER auto-folded into the account's sign-up ToS consent: they migrate ONLY when the shopper has
// separately granted Consent 2 for the account too; otherwise they are DROPPED rather than silently
// promoted onto a weaker consent basis.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS COPIES AND NEVER DELETES (B12(b), changed deliberately — it used to `deleteNamespace` the
// guest). Two reasons, and the first is a security one:
//
//   1. Nothing proves a client-supplied `anonId` belongs to its caller — that is C1, ACCEPTED AS IS by
//      the named owner on the reasoning that obtaining one realistically requires access to the victim's
//      browser. Under MOVE semantics that acceptance did not hold: an attacker presenting a victim's
//      `anonId` while signed in as themselves took the victim's facts AND THE VICTIM LOST THEM. That is
//      strictly worse than the read exposure C1 accepts, which is why the earlier version of this
//      migration was removed as a data-theft vector before it ever merged. Copying reduces the residual
//      to "someone with your device could copy facts they can already read via C1" — no new access, and
//      no destruction, because there is no deletion primitive here at all.
//   2. "The guest remains usable" requires it. Signing out must not wipe the memory you built as a guest.
//
// The guest copy is not immortal: nothing writes to it once the shopper is signed in, so the scheduled
// retention sweep (MEMORY-GO-LIVE-CHECKLIST B4) reclaims it on the ordinary TTL. Data minimisation
// happens by EXPIRY rather than by a delete this code could get wrong.
//
// The rejected alternative, recorded because it is the obvious one: make the guest id server-issued and
// signed so the migration is driven by a verified identity (the Firebase anonymous-auth pattern). It was
// not taken because the credential would live in the SAME partitioned iframe localStorage the `anonId`
// already occupies and travel on the same calls, so the acquisition requirement — device access — is
// unchanged. It buys principle, not protection. That is the same conclusion C1's own decision records.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

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
 * Audited guest -> account fact CARRY-OVER (ADR-0015 Tier 2). Ordinary facts always follow;
 * special-category facts follow ONLY when `ctx.consent2 === "in"` (Inv 9).
 *
 * The guest namespace is left INTACT (see the module header for why). Calling this repeatedly is safe and
 * silent: it migrates only ids the account does not already hold, returns `{merged: 0}` when there is
 * nothing new, and writes an audit row ONLY when something actually moved. Safe to call on every verified
 * turn, which is exactly what the production caller does.
 *
 * Because the source survives, a fact DROPPED by Inv 9 on one call can still follow on a later one — if
 * the shopper grants Consent 2 for the account afterwards, the next call picks it up. Under the old MOVE
 * semantics that fact was gone for good.
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
  // Cheap exit: no guest facts means no second query and NO audit row. The production caller runs on
  // every verified turn that presents a guest anonId, so "nothing happened" must cost nothing and must
  // not be recorded — Inv 6 forbids a silent ACTION, not doing nothing.
  if (matches.length === 0) return { merged: 0 };

  // Copying is not self-limiting the way the old MOVE was (it erased its own source), so idempotence has
  // to come from CONTENT: migrate only ids the account does not already hold. Without this, every turn
  // would re-upsert the same facts and write a fresh `merge` audit row into an append-only log.
  const alreadyHeld = new Set(
    (await deps.vector.query(accountNamespace, { text: "", k: QUERY_LIMIT })).map((m) => m.id),
  );

  const toMigrate: VectorRecord[] = [];
  for (const match of matches) {
    const meta = match.metadata as Partial<FactMetadata> | undefined;
    if (meta?.class === "special" && ctx.consent2 !== "in") continue; // Inv 9 — dropped, never promoted
    if (alreadyHeld.has(match.id)) continue;
    toMigrate.push({ id: match.id, text: meta?.text, metadata: match.metadata });
  }

  if (toMigrate.length === 0) return { merged: 0 }; // nothing moved ⇒ nothing to audit

  await deps.vector.upsert(accountNamespace, toMigrate);
  // THE GUEST NAMESPACE IS DELIBERATELY LEFT ALONE — see this module's header. It is not orphaned: it
  // stops being written to once the shopper is signed in, so the scheduled retention sweep (B4) reclaims
  // it on the ordinary TTL. Minimisation by expiry, with no deletion primitive for an attacker to reach.

  await deps.audit.audit(
    { tenantId: ctx.tenantId },
    buildMemoryAudit({ action: "merge", tenantId: ctx.tenantId, anonId: ctx.anonId, count: toMigrate.length, hmacKey: deps.hmacKey }),
  );

  return { merged: toMigrate.length };
}
