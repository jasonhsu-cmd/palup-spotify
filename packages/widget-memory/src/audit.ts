import { createHash, createHmac } from "node:crypto";
import type { AuditInput } from "@palup/platform-ports";
import type { FactClass } from "./classifier.js";

// ADR-0015 Inv 6 (consent + memory access are audited — no silent memory action) + Inv 5
// (right-to-erasure is audited). Mirrors packages/widget-backend/src/audit.ts's AuditInput shape
// (actor, action, input, decision, reversalPath) and its PII discipline exactly: the raw
// tenant/subject identifier is hashed to an opaque ref (never the raw anonId), and fact TEXT never
// lands in the immutable log — only its sensitivity class and a count.
//
// MEDIUM finding (security-review remediation, PR #152) — widget-backend/src/audit.ts's OWN rule
// (`hashShopperRef`'s doc comment) is that a shopperId is LOW-ENTROPY (the merchant is public/known and
// the numeric customer id space is small per store), so a bare/unsalted hash of it is brute-forceable
// and the ref MUST be a KEYED HMAC. Subject-scoped auth (identity.ts `accountSubjectId`) now routes
// exactly that id — `acct:shopify:<tenant>:<numeric customerId>` — through `subjectRef` below on every
// memory audit action, including `erase.subject`. `hmacKey`, when supplied, makes this ref pseudonymous
// (recoverable only by whoever holds the key) instead of brute-forceable; when omitted it falls back to
// the prior unsalted sha256 — which remains fine for a GUEST anon id (128 bits of `crypto.randomBytes`,
// identity.ts `generateGuestId` — inherently high-entropy, not brute-forceable regardless of the hash
// function) but is NOT a safe ref for an `acct:` subject. Callers should supply `hmacKey` (mirroring
// server.ts's own `AUDIT_HMAC_SECRET` pattern) whenever one is configured; see server.ts for exactly
// when that is guaranteed (shopper auth requires SHOPPER_TOKEN_SECRET, which AUDIT_HMAC_SECRET defaults
// to when not separately provisioned).

export type MemoryAction =
  | "consent.granted"
  | "consent.withdrawn"
  | "write.ordinary"
  | "write.special"
  | "write.refused"
  | "recall"
  | "erase.subject"
  | "erase.tenant"
  | "merge"
  | "ttl_sweep"
  | "ttl_renew"
  | "recall.dropped";

const ACTOR = "agent:shopper-memory";

const REVERSAL_PATHS: Record<MemoryAction, string> = {
  "consent.granted": "shopper may withdraw via the manage-memory / forget-me control",
  "consent.withdrawn": "n/a — withdrawal is itself the reversal; re-granting re-enables writes",
  "write.ordinary": "erase this subject's memory via the vector port (deleteById/deleteNamespace)",
  "write.special": "erase-first: withdrawing Consent 2 purges this fact via the vector port",
  "write.refused":
    "n/a — nothing was persisted to reverse; provision the tenant's MEMORY_ENCRYPTION_KEY so future special-category writes are no longer refused (already-refused turns are not retroactively recoverable)",
  recall: "n/a — read-only, no state change",
  "erase.subject": "n/a — erasure is itself the reversal path (right-to-erasure is irreversible by design)",
  "erase.tenant": "n/a — erasure is itself the reversal path (right-to-erasure is irreversible by design)",
  merge: "irreversible: the pre-merge anon-id namespace is DELETED on merge; the migrated facts live under the account namespace, from which the account's own erasure/withdrawal applies",
  ttl_sweep: "n/a — expiry is policy-driven; a fresh consent grant starts a new TTL",
  "ttl_renew":
    "shopper may withdraw (manage-memory / forget-me) — a withdrawn fact is never renewed again and ages out on its current expiry; erasure purges it immediately",
  "recall.dropped":
    "restore the key the record was written under (its outgoing value belongs at <MEMORY_ENCRYPTION_KEY>_previous for one rotation cycle) and the record decrypts again; without it the record is unrecoverable and should be erased",
};

/** Opaque reference to a subject — NEVER the raw anonId/account id, so the immutable, long-lived audit
 * log can't itself become a re-identification surface. Mirrors widget-backend/src/audit.ts's
 * `hashShopperRef`/`sessionRef` pattern: KEYED HMAC-SHA256 when `hmacKey` is supplied (required for a
 * low-entropy `acct:` subject to be genuinely pseudonymous, not brute-forceable — see this module's
 * header note), else the prior plain sha256 (safe only for a high-entropy guest anon id). Exported so
 * retention.ts's PII-free operator-visible failure signal (security review, Finding 1) can identify a
 * subject without ever logging the raw anonId. */
export function subjectRef(tenantId: string, anonId: string, hmacKey?: string): string {
  const input = `${tenantId}::${anonId}`;
  return hmacKey ? createHmac("sha256", hmacKey).update(input).digest("hex").slice(0, 16) : createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/**
 * Builds the AuditInput for one memory-subsystem action. Actor is always the memory subsystem's own
 * agent identity; input carries only a HASHED subjectRef (never the raw anonId); decision carries only
 * the sensitivity class + a count (NEVER the fact text itself). `hmacKey` is threaded through to
 * `subjectRef` (see its own doc comment) — supply it whenever one is configured, required for an
 * `acct:` subject ref to be more than an unsalted, brute-forceable hash.
 */
export function buildMemoryAudit(args: {
  action: MemoryAction;
  tenantId: string;
  anonId: string;
  factClass?: FactClass;
  count?: number;
  hmacKey?: string;
}): AuditInput {
  return {
    actor: ACTOR,
    action: args.action,
    input: { subjectRef: subjectRef(args.tenantId, args.anonId, args.hmacKey) },
    decision: { class: args.factClass, count: args.count ?? 0 },
    reversalPath: REVERSAL_PATHS[args.action],
  };
}
