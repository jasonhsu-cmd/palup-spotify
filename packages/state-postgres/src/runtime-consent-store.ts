import { createHash, createHmac } from "node:crypto";
import type { RuntimeStatePort } from "@palup/platform-ports";
import type { Consent } from "@palup/widget-brain";

// PR-11a — server-side consent-record plumbing (ADR-0015 T12). Mirrors runtime-kill-registry.ts's
// structure: tenant-scoped rows on the SAME RuntimeStatePort (Postgres in prod via DATABASE_URL,
// in-memory in tests) — one storage abstraction for both, no new port surface — and the write is
// committed INSIDE a transaction together with its immutable audit record (NN #5), so the consent
// change and its audit can never drift apart on a mid-write failure.
//
// This is ONLY the record/lookup plumbing that closes widget-backend/src/signals.ts's hardcoded
// `consent.memoryOrdinary/memorySpecial = "unknown"`. It does not decide anything: `decideMemoryWrite`
// (widget-memory/src/consent.ts, reused UNCHANGED) is still the sole place a region/consent-tier policy
// is applied. Recording/looking up a preference here is inert on its own — nothing acts on it until the
// (separately gated, still-false) MEMORY_ADR_ACCEPTED flip.
//
// TENANT SCOPING: unlike the kill registry (which needs a reserved SYSTEM tenant for cross-tenant
// operator scopes), a memory-consent record is inherently single-tenant — a shopper's choice for
// merchant A says nothing about merchant B. So this store keys directly off the CALLER's own
// RuntimeStateCtx.tenantId (mirrors customer-grant-store.ts's `{ tenantId: tenant }` keying), giving
// tenant isolation for free from the port's own guarantee — no manual scope-precedence logic needed.

const MEMORY_CONSENT = "memory_consent"; // KV collection under the subject's OWN tenant

/** The two independent ADR-0015 memory-consent tiers for one subject. */
export interface ConsentRecord {
  /** Consent 1 — ordinary personal-data / cross-visit memory (Art. 6). */
  memoryOrdinary: Consent;
  /** Consent 2 — explicit special-category / health-data consent (Art. 9). Independent of Consent 1. */
  memorySpecial: Consent;
}

export interface RecordConsentInput extends ConsentRecord {
  tenantId: string;
  /** The subject key — the SAME validated anonId (or account id, post-merge) `signals.anonId` carries. */
  anonId: string;
  /** MEDIUM finding (security-review remediation, PR #152) — keyed-HMAC key for the audit `subjectRef`
   * below. Optional: omitted falls back to a plain sha256, which is only safe for a high-entropy guest
   * anon id — required for a low-entropy `acct:` subject's ref to be genuinely pseudonymous rather than
   * brute-forceable (mirrors widget-backend/src/audit.ts's `hashShopperRef` rule and server.ts's own
   * `AUDIT_HMAC_SECRET`). */
  hmacKey?: string;
  /** WHO caused this record (security review, PR #152 Finding 2). `"shopper"` = an explicit
   * `POST /consent` the shopper made. `"guest-merge"` = the SERVER derived it: /chat's restrictive
   * merge discovered a guest `"out"` and wrote it through to the account subject. The two were
   * previously byte-indistinguishable in the immutable log, so an operator could not tell a consent
   * change the shopper MADE from one the system INFERRED — and the shopper-facing reversal path is not
   * even true for the merged case (NN#5 / Inv 6).
   *
   * REQUIRED, not optional-with-a-default (security review, round 4): defaulting to `"shopper"` would
   * mean a future server-side caller that forgets this field silently ATTRIBUTES ITS OWN WRITE TO THE
   * SHOPPER in the immutable log — the wrong direction to fail for an Inv-6 attribution field. Making it
   * required forces every new call site to state who caused the change. */
  source: "shopper" | "guest-merge" | "account-out-propagation";
}

export interface LookupConsentInput {
  tenantId: string;
  anonId: string;
}

/** Fail-closed default when no record exists yet — never "in"/allowed by omission (mirrors
 * decideMemoryWrite's own fail-closed bias: an unknown consent state is never treated as granted). */
const NO_RECORD: ConsentRecord = { memoryOrdinary: "unknown", memorySpecial: "unknown" };

/** Opaque reference to a subject for the audit log — NEVER the raw anonId (mirrors
 * widget-memory/src/audit.ts's subjectRef and widget-backend/src/audit.ts's sessionRef/hashShopperRef
 * patterns), so the immutable, long-lived audit log can't itself become a re-identification surface.
 *
 * MEDIUM finding (security-review remediation, PR #152) — widget-backend/src/audit.ts's OWN rule is
 * that a shopperId is LOW-ENTROPY (public/known merchant + a small per-store numeric customer-id space),
 * so a bare/unsalted hash is brute-forceable and the ref MUST be a KEYED HMAC. Subject-scoped auth now
 * routes exactly that id (`acct:shopify:<tenant>:<numeric customerId>`) through this function on every
 * `consent.record` audit. `hmacKey`, when supplied, makes the ref pseudonymous instead of
 * brute-forceable; when omitted it falls back to the prior unsalted sha256 — which remains fine for a
 * high-entropy guest anon id but is NOT a safe ref for an `acct:` subject. */
function subjectRef(tenantId: string, anonId: string, hmacKey?: string): string {
  const input = `${tenantId}::${anonId}`;
  return hmacKey ? createHmac("sha256", hmacKey).update(input).digest("hex").slice(0, 16) : createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/**
 * Persist a subject's memory-consent tri-states — TENANT-SCOPED (keyed under `input.tenantId`, never a
 * cross-tenant write), keyed by `input.anonId`. Overwrites any prior record for this subject (a fresh
 * choice always wins — there is no history to reconcile). Audited atomically with the write.
 */
export async function recordConsent(
  store: RuntimeStatePort,
  input: RecordConsentInput,
  at = new Date().toISOString(),
): Promise<void> {
  const { tenantId, anonId, memoryOrdinary, memorySpecial, hmacKey, source } = input;
  // The TYPE says `source` is required, but nothing in this repo enforces types: there is no root
  // tsconfig and CI runs no typecheck step (vitest strips types without checking), so a future call site
  // that omits it would ship green — and the ternary below would then silently record `actor: "shopper"`
  // for a SERVER-derived write, the exact misattribution this field exists to prevent (security review,
  // PR #152). Fail loudly instead: an omission is a programming error, and a wrong actor in an immutable
  // Inv-6 log is worse than a rejected write. Both production call sites supply it (server.ts).
  if (source !== "shopper" && source !== "guest-merge" && source !== "account-out-propagation")
    throw new Error(`recordConsent: 'source' must be "shopper", "guest-merge" or "account-out-propagation" (got ${JSON.stringify(source)}) — it attributes this entry in the immutable audit log`);
  const record: ConsentRecord = { memoryOrdinary, memorySpecial };
  await store.tx({ tenantId }, async (t) => {
    await t.put(MEMORY_CONSENT, anonId, record);
    await t.audit(
      {
        actor: source === "shopper" ? "shopper" : "agent:shopper-memory",
        action: "consent.record",
        // PII-safe: only a hashed subjectRef + the tri-state choices — never the raw anonId.
        input: { subjectRef: subjectRef(tenantId, anonId, hmacKey), memoryOrdinary, memorySpecial, source },
        decision: "recorded",
        reversalPath:
          source === "guest-merge" || source === "account-out-propagation"
            ? // VERIFIED BY EXECUTION (governance review round 5 — three earlier revisions of this string
              // were written by REASONING and were each wrong; these claims are now backed by tests in
              // consent-restrictive-merge.test.ts, "BLOCK-1(a)" and "BLOCK-1(b)"):
              //   • ORDER IS LOAD-BEARING. Setting the ACCOUNT subject first does NOT work — the next
              //     /chat turn that still presents the originating guest anonId re-reads the guest row and
              //     re-durabilises "out" over it.
              //   • ERASURE IS NOT REQUIRED. `/consent` binds to the GUEST subject whenever no shopper
              //     token is presented, so a signed-out client holding the same anonId can clear the guest
              //     row directly. An earlier revision prescribed forget-me (which erases the shopper's
              //     facts) as the only escape — actively harmful advice in a field an operator or support
              //     agent follows literally.
              "reversible, but ORDER MATTERS: (1) FIRST neutralise the originating guest subject — either record the desired value on it from a SIGNED-OUT client (no shopper token; non-destructive, nothing is erased), or stop presenting that guest anonId entirely (the widget's forget-me mints a fresh one, which DOES erase the shopper's facts); THEN (2) record the desired value on this account subject while signed in. Doing (2) before (1) is undone by any /chat turn that intervenes while the guest anonId is still presented. See docs/MEMORY-GO-LIVE-CHECKLIST.md C7."
            : "POST /consent again with a different choice (e.g. 'out') — a fresh choice always overwrites the prior one",
      },
      at,
    );
  });
}

/**
 * The subject's recorded memory-consent tri-states, or the fail-closed default (`"unknown"/"unknown"`)
 * when no record exists yet. TENANT-SCOPED — reads only ever see rows under `input.tenantId`; a record
 * written for one tenant is invisible to every other tenant, even for the identical `anonId`.
 */
export async function lookupConsent(store: RuntimeStatePort, input: LookupConsentInput): Promise<ConsentRecord> {
  const rec = await store.get<ConsentRecord>({ tenantId: input.tenantId }, MEMORY_CONSENT, input.anonId);
  return rec ?? NO_RECORD;
}
