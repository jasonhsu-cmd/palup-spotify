import type { RuntimeStatePort, VectorListItem, VectorPort, VectorRecord } from "@palup/platform-ports";
import { subjectNamespace, floorNamespace, accountSubjectId } from "./identity.js";
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
  /** R2-2 (both-sides consent) — Consent 2 status FOR THE GUEST subject being merged FROM (its own
   * recorded `memorySpecial`, looked up the SAME way the account's `consent2` is). A special-category
   * fact must never be promoted onto the account's consent alone: the GUEST must have separately opted
   * in too, or the merge would let a shopper's account-level Consent-2 grant retroactively "claim"
   * health facts the guest session itself never authorised for carry-over (they may have been left there
   * by a different person on a shared device, or granted only for THAT anonymous session). Trusting a
   * guest "in" here — unlike `consent.ts`'s `mergeConsentTier`, which explicitly REFUSES to adopt a guest
   * "in" for its unauthenticated raw-anonId write path — is safe specifically BECAUSE this `anonId` is
   * never a client-supplied string: every caller of `mergeGuestIntoAccount` must derive it from a
   * server-VERIFIED, SIGNED guest token (see server.ts's `guestAnonIdFrom`), so there is no bearer-token-
   * guessing / cross-subject-borrowing risk the way there would be if this ran off a raw `body.anonId`. */
  consent2Source: MemoryConsent;
  /** Q19(c) — whether health-data carry-over was named/disclosed to the shopper at sign-in (distinct
   * from EITHER consent tier: a shopper can have granted Consent 2 for both subjects and still never have
   * been told that signing in would carry health facts across). A special-category fact migrates ONLY
   * when this is `true` AND both consent tiers above are `"in"` — the compound gate immediately below. */
  healthDisclosed: boolean;
}

/**
 * Audited guest -> account fact CARRY-OVER (ADR-0015 Tier 2). Ordinary (Art-6) facts always follow,
 * UNCHANGED by the special-category gate below — there is no new gate on them here, deliberately.
 * Special-category (Art-9) facts follow ONLY when the R2-2 + Q19(c) compound gate holds: the ACCOUNT's
 * own `consent2 === "in"` AND the GUEST's own `consent2Source === "in"` AND `healthDisclosed === true`
 * (Inv 9, extended). Any one of the three failing drops the row from THIS migration — never promoted
 * onto a single insufficient signal alone. See `MergeCtx`'s own doc comments for each field.
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
  // #125 — special-category facts now live in a dedicated per-subject FLOOR namespace, guest side and
  // account side alike. The merge must carry THAT namespace over too (gated on Inv 9, exactly like the
  // legacy in-main-namespace case below) — otherwise a guest's allergy/health facts would never follow
  // them to their account at all, even with Consent 2 granted.
  const anonFloorNamespace = floorNamespace(ctx.tenantId, ctx.anonId);
  const destAnonId = accountSubjectId(ctx.accountId);
  const accountNamespace = subjectNamespace(ctx.tenantId, destAnonId);
  const accountFloorNamespace = floorNamespace(ctx.tenantId, destAnonId);

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
  // #125 — read to exhaustion just like the main namespace; NO dual-read (the main namespace is never
  // re-scanned for floor rows — a row written after this PR only ever lives in one place).
  const floorMatches = await listAll(deps.vector, anonFloorNamespace);
  // No guest facts anywhere (main OR floor): nothing to migrate, but the guest namespace(s) were still
  // READ under an account principal — that cross-subject read is recorded (count 0), never silently
  // skipped.
  if (matches.length === 0 && floorMatches.length === 0) {
    await recordMerge(0);
    return { merged: 0 };
  }

  // Copying is not self-limiting the way the old MOVE was (it erased its own source), so idempotence has
  // to come from CONTENT: migrate only ids the account does not already hold. Without this, every turn
  // would re-upsert the same facts and write a fresh `merge` audit row into an append-only log.
  const alreadyHeld = new Set((await listAll(deps.vector, accountNamespace)).map((m) => m.id));
  const alreadyHeldFloor = new Set((await listAll(deps.vector, accountFloorNamespace)).map((m) => m.id));

  const toMigrate: VectorRecord[] = [];
  for (const match of matches) {
    const meta = match.metadata as Partial<FactMetadata> | undefined;
    // Defense-in-depth: post-#125 a `class:"special"` row should never appear in the MAIN namespace (it
    // routes to the floor at write time), but Inv 9's gate still applies here in case one does — a
    // pre-existing row seeded directly at the port layer, or written before this PR ever shipped.
    //
    // R2-2 + Q19(c) — the compound special-category gate: ALL THREE of (account consent2 "in") AND
    // (guest consent2Source "in") AND (healthDisclosed) must hold, or the row is dropped rather than
    // promoted on any single one of those alone. See MergeCtx's own doc comments for why trusting the
    // guest "in" here is safe (a server-verified signed guest token, not a raw/guessable anonId) —
    // unlike consent.ts's `mergeConsentTier`, which refuses a guest "in" for its unauthenticated
    // raw-anonId write path.
    if (meta?.class === "special" && !(ctx.consent2 === "in" && ctx.consent2Source === "in" && ctx.healthDisclosed)) continue;
    if (alreadyHeld.has(match.id)) continue;
    toMigrate.push({ id: match.id, text: meta?.text, metadata: match.metadata });
  }

  // #125 — every row in the FLOOR namespace IS a safety-floor (special-category) fact by construction, so
  // Inv 9's gate applies unconditionally here: it migrates to the account's OWN floor namespace only when
  // Consent 2 is explicitly granted for the account, otherwise it is dropped from THIS migration exactly
  // like the legacy in-main-namespace case above (never removed from the guest's own floor namespace —
  // copy-not-move, same as the rest of this function).
  const toMigrateFloor: VectorRecord[] = [];
  for (const match of floorMatches) {
    // R2-2 + Q19(c) — same compound gate as the main-namespace case above: account consent2 "in" AND
    // guest consent2Source "in" AND healthDisclosed, all three, or dropped (never promoted on any one
    // alone). Every row here IS a safety-floor (special-category) fact by construction (#125), so the
    // gate applies unconditionally.
    if (!(ctx.consent2 === "in" && ctx.consent2Source === "in" && ctx.healthDisclosed)) continue;
    if (alreadyHeldFloor.has(match.id)) continue;
    const meta = match.metadata as Partial<FactMetadata> | undefined;
    toMigrateFloor.push({ id: match.id, text: meta?.text, metadata: match.metadata });
  }

  // Nothing new to move anywhere (already held, or dropped by Inv 9) — still a cross-subject read of a
  // non-empty guest namespace, so it is still recorded (count 0), not skipped.
  if (toMigrate.length === 0 && toMigrateFloor.length === 0) {
    await recordMerge(0);
    return { merged: 0 };
  }

  // §5 / security-review LOW-1 — a throw BETWEEN the two upserts (or during either) can leave facts already
  // landed in the account namespace with no audit row if the audit is written only after both succeed. Every
  // autonomous write must be logged (NN#5), so track what actually landed and, on any error, record that
  // partial count before rethrowing (the caller then returns 500; a retry is idempotent — copy-not-move +
  // content dedup). `recordMerge` still fires exactly once on every path.
  let mergedSoFar = 0;
  try {
    if (toMigrate.length > 0) {
      await deps.vector.upsert(accountNamespace, toMigrate);
      mergedSoFar += toMigrate.length;
    }
    if (toMigrateFloor.length > 0) {
      await deps.vector.upsert(accountFloorNamespace, toMigrateFloor);
      mergedSoFar += toMigrateFloor.length;
    }
  } catch (e) {
    await recordMerge(mergedSoFar); // audit whatever actually landed, even on partial failure
    throw e;
  }
  // THE GUEST NAMESPACE(S) ARE DELIBERATELY LEFT ALONE — see this module's header. Neither is orphaned:
  // both stop being written to once the shopper is signed in, so the scheduled retention sweep (B4)
  // reclaims them on the ordinary TTL. Minimisation by expiry, with no deletion primitive for an attacker
  // to reach.

  await recordMerge(mergedSoFar);

  return { merged: mergedSoFar };
}
