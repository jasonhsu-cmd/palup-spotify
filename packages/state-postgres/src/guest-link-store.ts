import { createHash, createHmac } from "node:crypto";
import type { RuntimeStatePort } from "@palup/platform-ports";

// B12 — a durable, SERVER-recorded guest anonId -> verified account association
// (docs/MEMORY-GO-LIVE-CHECKLIST.md B12/C14). Mirrors runtime-consent-store.ts exactly in shape and
// discipline: tenant-scoped KV under the CALLER's own tenant, atomic write+audit (NN#5), hashed subject
// refs (never a raw anonId/account id in the audit log), keyed HMAC via the SAME `hmacKey` convention
// every other memory audit call site uses.
//
// WHY THIS EXISTS (C14): an authenticated shopper's opt-out is recorded against `acct:<shopperId>`
// (subject-scoped auth, widget-memory/src/identity.ts) and NEVER against the guest `anonId` their
// browser still holds (a supplied anonId is IGNORED for a verified shopper — this PR's founding
// property) — so it never governs a LATER turn where that same browser presents no shopper token
// (token expiry, sessionStorage 1h TTL, a new tab). Three attempts to fix this by propagating a
// CONSENT VALUE across subjects inside `POST /consent` were each rejected in review (see server.ts's
// own note at that call site) because they all ended up trusting a CLIENT-SUPPLIED anonId as if it
// were the caller's own. This store instead records only an IDENTITY ASSOCIATION — which anonId
// belonged to which verified account — and ONLY from a request the server itself verified
// (`verifiedShopperId` present). server.ts's `/chat` handler later CONSULTS this link on an unverified
// turn to fold the linked account's consent RESTRICTIVELY into that turn's decision — it is never used
// to change WHOSE memory is served. THE LOAD-BEARING CONSTRAINT: the subject always stays the guest
// anonId on an unverified turn — see server.ts's own doc comment above `/consent` and the "no read
// escalation" test in subject-scoped-memory-auth.test.ts. If an unverified turn holding a linked anonId
// ever resolved to the account subject instead, anyone holding that anonId could read the ACCOUNT's
// entire memory — escalating C1 from "the victim's guest preferences" to "the victim's whole account".
//
// C15 (link squatting) — human-owner-directed remedy, option (b) — REVOCABLE + SELF-HEALING:
// this store used to be first-writer-wins (server.ts gated the call on `if (!existingLink)`), which let
// any verified shopper who obtained a victim's anonId bind it to THEIR OWN account and durably deny the
// victim, unrevocably. Fixed two ways, both here:
//   1. `recordGuestLink` is now LAST-VERIFIED-writer-wins: every verified `/consent` call presenting a
//      validated anonId OVERWRITES whatever the link currently says, atomically inside ONE `store.tx`
//      (no separate outside-the-tx existence check, so the prior TOCTOU race is gone), and returns
//      whether it actually changed anything so a no-op re-post neither re-audits nor floods the log.
//   2. `clearGuestLinkIfOwnedBy` lets the account a link ALREADY points at remove it entirely (server.ts
//      `/forget`). THE TRAP, get it wrong and you re-open C14: clearing a link REMOVES a narrowing
//      input, so an UNRESTRICTED clear would hand an attacker a permissive-direction primitive against a
//      victim whose account's "out" currently governs their signed-out turns via this link. So this
//      function checks ownership and deletes ATOMICALLY inside one `store.tx`, and is a no-op — the link
//      is left completely untouched — for every caller whose account is not the one already recorded.
// NOT ELIMINATED: an attacker who keeps re-obtaining the same anonId can keep re-squatting; each round
// again denies the rightful account until it acts again. Bounded by the 128-bit anonId precondition, the
// per-IP/per-tenant rate limits, and the kill switch (server.ts) — and now always non-destructively
// escapable, which it was not before. See docs/MEMORY-GO-LIVE-CHECKLIST.md C15's current text.
//
// TRUST NOTE (same class as the existing C1/C8/C10 residuals, docs/MEMORY-GO-LIVE-CHECKLIST.md):
// `validateAnonId` proves the presented anonId is well-FORMED, never that the verified shopper
// presenting it actually OWNS it (holds the browser it was minted for). A verified shopper who presents
// a validated anonId they merely obtained (not their own browser's) can still cause a link to be
// recorded from that anonId to THEIR account, exactly as C8/C10 already accept for consent writes — for
// the CONSENT decision this is directionally safe (mergeAccountConsent never adopts the linked side's
// "in"; it can only ever push a decision toward "out"). The FACT migration this link was originally paired with (REMOVED — see server.ts)
// (server.ts `/consent`, `mergeGuestIntoAccount`) is a materially STRONGER consequence than the
// pre-existing consent-oracle class, because it moves data ownership rather than only reading/denying —
// see the note at that call site and docs/MEMORY-GO-LIVE-CHECKLIST.md's C1 row. Nothing in this system
// still proves an anonId belongs to the caller (residual C1) — the fix above closes the SQUATTING class'
// unrevocability, not that root cause.

const GUEST_LINK = "guest_account_link"; // KV collection under the subject's OWN tenant

export interface GuestLinkRecord {
  accountSubject: string;
}

export interface RecordGuestLinkInput {
  tenantId: string;
  /** The validated guest anonId being linked — never a raw, unvalidated client string. */
  guestAnonId: string;
  /** The SERVER-verified account subject (`acct:<shopperId>`, identity.ts `accountSubjectId`) this
   * anonId belongs to, per the request that established this link. */
  accountSubject: string;
  hmacKey?: string;
}

/** Result of `recordGuestLink` — `changed` is false for an identical no-op re-post (same guestAnonId,
 * same accountSubject already on record), so a caller can avoid treating a no-op as a fresh event. */
export interface RecordGuestLinkResult {
  changed: boolean;
}

export interface ClearGuestLinkInput {
  tenantId: string;
  guestAnonId: string;
  /** The CALLER's own server-verified account subject. The link is deleted ONLY if it already points at
   * exactly this subject — see `clearGuestLinkIfOwnedBy`'s own doc comment for why this check exists. */
  accountSubject: string;
  hmacKey?: string;
}

/** Result of `clearGuestLinkIfOwnedBy` — `cleared` is false whenever the link didn't already belong to
 * the caller (including "no link exists"), in which case nothing was touched. */
export interface ClearGuestLinkResult {
  cleared: boolean;
}

export interface LookupGuestLinkInput {
  tenantId: string;
  guestAnonId: string;
}

/** Mirrors runtime-consent-store.ts's own `subjectRef` — an independent copy, not a shared import,
 * matching this package's existing convention (audit.ts/flag.ts/runtime-consent-store.ts each keep
 * their own copy rather than a shared helper). */
function subjectRef(tenantId: string, subject: string, hmacKey?: string): string {
  const input = `${tenantId}::${subject}`;
  return hmacKey ? createHmac("sha256", hmacKey).update(input).digest("hex").slice(0, 16) : createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/**
 * Records a guest anonId -> account subject association, TENANT-SCOPED. C15(b) — LAST-VERIFIED-writer-
 * wins, decided ATOMICALLY inside one `store.tx`: reads the existing link (if any) and, only if the
 * accountSubject actually differs (or no link exists yet), overwrites it and audits the change — an
 * identical re-post of the SAME (guestAnonId, accountSubject) is a no-op: no write, no audit, so a
 * verified shopper's browser re-posting the same /consent choice never floods the log. Because the read
 * and the write happen inside the SAME transaction, there is no window between "check" and "write" a
 * concurrent call could race (the prior TOCTOU: server.ts used to read `lookupGuestLink` OUTSIDE this
 * function's own transaction).
 *
 * This is what makes squatting non-destructively repairable (C15): the rightful account can always
 * reclaim a link an attacker recorded first by doing exactly what they'd do anyway — sign in, post
 * /consent. It does NOT make squatting impossible: a link recorded here can equally be OVER-written by
 * whoever calls this next, including a fresh attacker. Callers MUST only ever invoke this from a request
 * the server itself verified (see this module's own header) — this function has no way to check that
 * itself; server.ts's `/consent` call site is the enforcement point.
 */
export async function recordGuestLink(
  store: RuntimeStatePort,
  input: RecordGuestLinkInput,
  at = new Date().toISOString(),
): Promise<RecordGuestLinkResult> {
  const { tenantId, guestAnonId, accountSubject, hmacKey } = input;
  return store.tx({ tenantId }, async (t) => {
    const existing = await t.get<GuestLinkRecord>(GUEST_LINK, guestAnonId);
    if (existing && existing.accountSubject === accountSubject) {
      return { changed: false };
    }
    await t.put(GUEST_LINK, guestAnonId, { accountSubject });
    await t.audit(
      {
        actor: "agent:shopper-memory",
        action: "guest_link.record",
        // PII-safe: only hashed refs for BOTH sides — never the raw anonId or account id.
        input: { guestRef: subjectRef(tenantId, guestAnonId, hmacKey), accountRef: subjectRef(tenantId, accountSubject, hmacKey) },
        decision: existing ? "relinked" : "linked",
        reversalPath:
          "REVERSIBLE, but the squatting CLASS is not eliminated (C15(b)): the account this link " +
          "currently points at — including the account being denied by it right now — can OVERWRITE it " +
          "at any time by signing in and posting a verified POST /consent presenting this SAME " +
          "guestAnonId (this function is last-VERIFIED-writer-wins, decided atomically in one store.tx). " +
          "That same account may instead remove the link entirely via POST /forget presenting this " +
          "guestAnonId while signed in (clearGuestLinkIfOwnedBy) — every OTHER caller's /forget leaves it " +
          "untouched, so this is not a route to erase someone else's link. NEITHER remedy is permanent: " +
          "a third party who again obtains this guestAnonId can re-record over it next, and each re-squat " +
          "again denies the rightful account until it acts again. Do not read this as \"C15 closed\" — " +
          "only as \"no longer unrevocable\". See docs/MEMORY-GO-LIVE-CHECKLIST.md C15.",
      },
      at,
    );
    return { changed: true };
  });
}

/**
 * C15(b) item 2 — removes a guest anonId -> account link, but ONLY when it already points at the
 * CALLER's own verified account (`input.accountSubject`). THE TRAP this guards against: clearing a link
 * REMOVES a narrowing input to `/chat`'s unverified-turn consent decision, so an UNRESTRICTED "anyone can
 * clear any link" would hand an attacker a PERMISSIVE-direction primitive — clearing a victim's own link
 * would silently stop the victim's account-level "out" from governing their signed-out turns, re-opening
 * exactly the hole C14/B12 closed. So this checks ownership and deletes ATOMICALLY inside one `store.tx`
 * (same TOCTOU discipline as `recordGuestLink`): a caller whose account is NOT the one recorded gets
 * `{ cleared: false }` and the link is left completely untouched — proven by
 * guest-account-link.test.ts's "cannot clear someone else's link" test. Callers MUST only ever invoke
 * this from a request the server itself verified — same enforcement-point contract as `recordGuestLink`.
 */
export async function clearGuestLinkIfOwnedBy(
  store: RuntimeStatePort,
  input: ClearGuestLinkInput,
  at = new Date().toISOString(),
): Promise<ClearGuestLinkResult> {
  const { tenantId, guestAnonId, accountSubject, hmacKey } = input;
  return store.tx({ tenantId }, async (t) => {
    const existing = await t.get<GuestLinkRecord>(GUEST_LINK, guestAnonId);
    if (!existing || existing.accountSubject !== accountSubject) {
      return { cleared: false };
    }
    await t.delete(GUEST_LINK, guestAnonId);
    await t.audit(
      {
        actor: "agent:shopper-memory",
        action: "guest_link.clear",
        input: { guestRef: subjectRef(tenantId, guestAnonId, hmacKey), accountRef: subjectRef(tenantId, accountSubject, hmacKey) },
        decision: "unlinked",
        reversalPath:
          "reversible: the SAME account may re-establish this link at any time by presenting this " +
          "guestAnonId again to a verified POST /consent call (recordGuestLink). Until then, no account " +
          "narrows this guestAnonId's unverified /chat turns.",
      },
      at,
    );
    return { cleared: true };
  });
}

/**
 * C15(b) item 3 (security MEDIUM, previously invisible) — audits that a linked account's consent
 * NARROWED an unverified `/chat` turn's decision. Read-only with respect to the link itself (nothing
 * here mutates it) — called by server.ts only when the merge actually differed from the guest's own
 * record, so a link that is present but changes nothing audits nothing (Inv 6 requires no SILENT
 * action, not an audit for a read that decided nothing). PII-safe: hashed refs for both sides, never the
 * raw guestAnonId/accountSubject, and never the shopper's message or fact text.
 */
export async function auditGuestLinkConsulted(
  store: RuntimeStatePort,
  input: { tenantId: string; guestAnonId: string; accountSubject: string; hmacKey?: string; narrowedOrdinary: boolean; narrowedSpecial: boolean },
  at = new Date().toISOString(),
): Promise<void> {
  const { tenantId, guestAnonId, accountSubject, hmacKey, narrowedOrdinary, narrowedSpecial } = input;
  await store.audit(
    { tenantId },
    {
      actor: "agent:shopper-memory",
      action: "guest_link.consulted",
      input: { guestRef: subjectRef(tenantId, guestAnonId, hmacKey), accountRef: subjectRef(tenantId, accountSubject, hmacKey), narrowedOrdinary, narrowedSpecial },
      decision: "narrowed",
      reversalPath:
        "n/a — read-only consult of an existing link; the underlying link's own record/clear actions " +
        "(guest_link.record / guest_link.clear) are what can be reversed, not this read.",
    },
    at,
  );
}

/**
 * C15(b) item 4 (security MEDIUM) — audits a FAILED `recordGuestLink` write, previously swallowed with
 * `console.error` only (failure direction is write-when-DENIED: a squatted/stale link simply stays in
 * place, which is why this needed to become visible in the immutable log at all, not just the console).
 * Called OUTSIDE any transaction — the failed write already rolled back inside `recordGuestLink`'s own
 * `store.tx`, so there is nothing left to commit atomically with this record (mirrors retention.ts's own
 * accepted residual: if THIS audit call itself throws, the caller's console.error is the only remaining
 * trace — see server.ts's own catch around this call).
 */
export async function auditGuestLinkWriteFailure(
  store: RuntimeStatePort,
  input: { tenantId: string; guestAnonId: string; accountSubject: string; hmacKey?: string; errorClass: string },
  at = new Date().toISOString(),
): Promise<void> {
  const { tenantId, guestAnonId, accountSubject, hmacKey, errorClass } = input;
  await store.audit(
    { tenantId },
    {
      actor: "agent:shopper-memory",
      action: "guest_link.write_failed",
      input: { guestRef: subjectRef(tenantId, guestAnonId, hmacKey), accountRef: subjectRef(tenantId, accountSubject, hmacKey), errorClass },
      decision: "not recorded",
      reversalPath:
        "n/a — nothing was persisted to reverse; a later verified /consent call presenting the same " +
        "guest anonId safely retries recordGuestLink (idempotent no-op if nothing would change, a fresh " +
        "write otherwise).",
    },
    at,
  );
}

/** The account subject linked to this guest anonId, or `undefined` if none has ever been recorded. */
export async function lookupGuestLink(store: RuntimeStatePort, input: LookupGuestLinkInput): Promise<GuestLinkRecord | undefined> {
  const rec = await store.get<GuestLinkRecord>({ tenantId: input.tenantId }, GUEST_LINK, input.guestAnonId);
  return rec ?? undefined;
}
