import type { RuntimeStatePort, VectorListItem, VectorPort, VectorRecord } from "@palup/platform-ports";
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

// semantic-memory-v1 foundation, T2 — RULING: page through a namespace's ENTIRE record set via
// `VectorPort.list` rather than a single capped `query(ns,{text:"",k:500})` — the old idiom both
// truncated at 500 (so a guest with >500 facts had some silently dropped by the migration) AND throws
// outright on a text-query-only-unsupported ANN adapter (pgvector). `PAGE_LIMIT` is the per-page size;
// `MAX_PAGES` is a generous defensive ceiling (PAGE_LIMIT * MAX_PAGES = 1,000,000 records) against a
// pathological/corrupt namespace, never a normal-path limit — exceeding it throws rather than silently
// truncating the migration.
const PAGE_LIMIT = 500;
const MAX_PAGES = 2000;

/** Thrown by `listAll` when a namespace isn't exhausted within `MAX_PAGES` pages — a backstop so a
 *  pathologically large/corrupt namespace can never be silently under-migrated. */
export class MergePageCeilingExceeded extends Error {
  constructor(namespace: string) {
    super(
      `mergeGuestIntoAccount: ${namespace} was not exhausted within MAX_PAGES=${MAX_PAGES} pages ` +
        `(PAGE_LIMIT=${PAGE_LIMIT}) — refusing to migrate from a partial enumeration`,
    );
    this.name = "MergePageCeilingExceeded";
  }
}

/** Walk `namespace` to exhaustion via `VectorPort.list` (ascending id, `after` an exclusive lower bound).
 *  A page shorter than `PAGE_LIMIT` is the exhaustion terminator; exceeding `MAX_PAGES` throws rather
 *  than ever silently truncating. */
async function listAll(vector: VectorPort, namespace: string): Promise<VectorListItem[]> {
  const out: VectorListItem[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await vector.list(namespace, { limit: PAGE_LIMIT, after });
    out.push(...batch);
    if (batch.length < PAGE_LIMIT) return out; // short page — namespace exhausted
    after = batch[batch.length - 1]!.id;
  }
  throw new MergePageCeilingExceeded(namespace);
}

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
 * The guest namespace is left INTACT (see the module header for why). Calling this repeatedly is safe:
 * it migrates only ids the account does not already hold, returning `{merged: 0}` when there is nothing
 * new. It is NOT silent, though (F-8/C9, ADR-0019 Revision 2 task 7): every call is itself a
 * cross-subject read of the guest namespace, so every call writes exactly one `merge` audit row — with
 * `count` distinguishing a real migration (>0) from a read that moved nothing (0) — carrying BOTH the
 * source (guest) and destination (account) subject refs, so an operator can reconstruct which account
 * received which guest's facts even when nothing moved. **Because every call now writes a row (including
 * no-ops), the eventual production caller (task 10) must fire this only on a RECORDED SHOPPER
 * AUTHORISATION per (aid, account) pair — R2-1, invariant 9 — NOT on every verified turn.** An every-turn
 * caller would append a `count:0` row to the append-only audit log on every message; the authorisation
 * gate is what bounds that. (There is no production caller yet; task 10 is legal-gated on Q19.)
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
  const destAnonId = accountSubjectId(ctx.accountId);
  const accountNamespace = subjectNamespace(ctx.tenantId, destAnonId);

  // F-8/C9 (ADR-0019 Revision 2 task 7) — every call below this point audits exactly once, carrying BOTH
  // subject refs, whatever `count` turns out to be. The querying of `anonNamespace` a few lines down is
  // itself the cross-subject read C9 is about: it happens whether or not anything ends up migrating, so
  // it must never be silent. `recordMerge` is the ONE place that writes the audit row, so every return
  // path below goes through it — no path can silently skip it.
  const recordMerge = (count: number) =>
    deps.audit.audit(
      { tenantId: ctx.tenantId },
      buildMemoryAudit({
        action: "merge",
        tenantId: ctx.tenantId,
        anonId: ctx.anonId,
        destAnonId,
        count,
        hmacKey: deps.hmacKey,
      }),
    );

  const matches = await listAll(deps.vector, anonNamespace);
  // No guest facts: nothing to migrate, but the guest namespace was still READ under an account
  // principal — that cross-subject read is recorded (count 0), never silently skipped.
  if (matches.length === 0) {
    await recordMerge(0);
    return { merged: 0 };
  }

  // Copying is not self-limiting the way the old MOVE was (it erased its own source), so idempotence has
  // to come from CONTENT: migrate only ids the account does not already hold. Without this, every turn
  // would re-upsert the same facts and write a fresh `merge` audit row into an append-only log.
  const alreadyHeld = new Set((await listAll(deps.vector, accountNamespace)).map((m) => m.id));

  const toMigrate: VectorRecord[] = [];
  for (const match of matches) {
    const meta = match.metadata as Partial<FactMetadata> | undefined;
    if (meta?.class === "special" && ctx.consent2 !== "in") continue; // Inv 9 — dropped, never promoted
    if (alreadyHeld.has(match.id)) continue;
    toMigrate.push({ id: match.id, text: meta?.text, metadata: match.metadata });
  }

  // Nothing new to move (already held, or dropped by Inv 9) — still a cross-subject read of a
  // non-empty guest namespace, so it is still recorded (count 0), not skipped.
  if (toMigrate.length === 0) {
    await recordMerge(0);
    return { merged: 0 };
  }

  await deps.vector.upsert(accountNamespace, toMigrate);
  // THE GUEST NAMESPACE IS DELIBERATELY LEFT ALONE — see this module's header. It is not orphaned: it
  // stops being written to once the shopper is signed in, so the scheduled retention sweep (B4) reclaims
  // it on the ordinary TTL. Minimisation by expiry, with no deletion primitive for an attacker to reach.

  await recordMerge(toMigrate.length);

  return { merged: toMigrate.length };
}
