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
// TRUST NOTE (same class as the existing C1/C8/C10 residuals, docs/MEMORY-GO-LIVE-CHECKLIST.md):
// `validateAnonId` proves the presented anonId is well-FORMED, never that the verified shopper
// presenting it actually OWNS it (holds the browser it was minted for). A verified shopper who presents
// a validated anonId they merely obtained (not their own browser's) can still cause a link to be
// recorded from that anonId to THEIR account, exactly as C8/C10 already accept for consent writes — for
// the CONSENT decision this is directionally safe (mergeAccountConsent never adopts the linked side's
// "in"; it can only ever push a decision toward "out"). The FACT migration this link was originally paired with (REMOVED — see server.ts)
// (server.ts `/consent`, `mergeGuestIntoAccount`) is a materially STRONGER consequence than the
// pre-existing consent-oracle class, because it moves data ownership rather than only reading/denying —
// see the note at that call site and docs/MEMORY-GO-LIVE-CHECKLIST.md's C1 row.

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
 * Records a guest anonId -> account subject association, TENANT-SCOPED, atomically with its audit
 * (NN#5). Overwrites any prior link for this guestAnonId (mirrors recordConsent's "a fresh choice
 * always overwrites the prior one" — there is no history to reconcile here either). Callers MUST only
 * ever invoke this from a request the server itself verified (see this module's own header) — this
 * function has no way to check that itself; server.ts's `/consent` call site is the enforcement point.
 */
export async function recordGuestLink(
  store: RuntimeStatePort,
  input: RecordGuestLinkInput,
  at = new Date().toISOString(),
): Promise<void> {
  const { tenantId, guestAnonId, accountSubject, hmacKey } = input;
  const record: GuestLinkRecord = { accountSubject };
  await store.tx({ tenantId }, async (t) => {
    await t.put(GUEST_LINK, guestAnonId, record);
    await t.audit(
      {
        actor: "agent:shopper-memory",
        action: "guest_link.record",
        // PII-safe: only hashed refs for BOTH sides — never the raw anonId or account id.
        input: { guestRef: subjectRef(tenantId, guestAnonId, hmacKey), accountRef: subjectRef(tenantId, accountSubject, hmacKey) },
        decision: "linked",
        reversalPath:
          "NOT REVERSIBLE — no unlink endpoint exists, /forget does not clear this collection, and the " +
          "record is first-writer-wins, so a link recorded against the WRONG account cannot be corrected " +
          "by the rightful account owner. The link is narrowing-only as an input to a later consent " +
          "decision (mergeAccountConsent never adopts the linked side's \"in\"), but narrowing-only is NOT " +
          "the same as safe: whoever records the link first chooses which account's consent narrows this " +
          "guest id's unverified turns, and a link recorded by someone who merely obtained the anonId " +
          "gives them a durable, unrevocable denial over that shopper's memory. An earlier revision of " +
          "this very string asserted \"nothing unsafe survives it going unreversed\" — that was FALSE. " +
          "See docs/MEMORY-GO-LIVE-CHECKLIST.md C15 (link squatting) and B12.",
      },
      at,
    );
  });
}

/** The account subject linked to this guest anonId, or `undefined` if none has ever been recorded. */
export async function lookupGuestLink(store: RuntimeStatePort, input: LookupGuestLinkInput): Promise<GuestLinkRecord | undefined> {
  const rec = await store.get<GuestLinkRecord>({ tenantId: input.tenantId }, GUEST_LINK, input.guestAnonId);
  return rec ?? undefined;
}
