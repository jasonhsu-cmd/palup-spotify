import { createHash, createHmac } from "node:crypto";
import type { RuntimeStatePort } from "@palup/platform-ports";

// WS-D (ADR-0015 Q19(c), MED-1 remediation) — server-recorded "health-data carry-over was disclosed to
// the shopper at sign-in". Mirrors runtime-consent-store.ts exactly: tenant-scoped rows on the SAME
// RuntimeStatePort, the write committed INSIDE a transaction with its immutable audit record (NN #5). This
// replaces the CLIENT-ASSERTED body.healthDisclosed the /memory/merge route trusted. No production caller
// writes a disclosure yet (the R2-1 carry-over prompt stays legal-gated, CARRY_OVER_PROMPT_ENABLED off);
// until one does, lookup returns its fail-closed default (false), so special-category rows never carry —
// the correct un-forgeable posture.

const MEMORY_HEALTH_DISCLOSURE = "memory_health_disclosure"; // KV collection under the subject's OWN tenant

interface DisclosureRecord {
  /** ISO timestamp the disclosure was recorded. Presence == disclosed; absence == fail-closed false. */
  disclosedAt: string;
}

export interface DisclosureInput {
  tenantId: string;
  /** The account subject key — the SAME value the merge route computes via memorySubjectId({verifiedShopperId}). */
  accountSubject: string;
  /** The server-verified guest subject the disclosure was named FOR (never a raw body.anonId). */
  guestAnonId: string;
}

/** Composite key: a disclosure authorizes exactly one (account, guest) carry-over, not the account broadly. */
const disclosureKey = (accountSubject: string, guestAnonId: string) => `${accountSubject}::${guestAnonId}`;

/** Opaque audit ref — never the raw ids. HMAC when a key is supplied (low-entropy acct: subject), else sha256.
 * Deliberately duplicated from runtime-consent-store.ts's own `subjectRef` (not exported/shared) — an
 * intentional isolation choice so this store has no import dependency on the consent store. */
function subjectRef(tenantId: string, key: string, hmacKey?: string): string {
  const input = `${tenantId}::${key}`;
  return hmacKey ? createHmac("sha256", hmacKey).update(input).digest("hex").slice(0, 16) : createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/**
 * Record that health-data carry-over was disclosed for this (account, guest) pair. TENANT-SCOPED. Audited
 * atomically with the write. Idempotent-ish: a repeat overwrites the timestamp (no history to reconcile).
 */
export async function recordHealthDisclosure(
  store: RuntimeStatePort,
  input: DisclosureInput & { hmacKey?: string },
  at = new Date().toISOString(),
): Promise<void> {
  const { tenantId, accountSubject, guestAnonId, hmacKey } = input;
  const key = disclosureKey(accountSubject, guestAnonId);
  const record: DisclosureRecord = { disclosedAt: at };
  await store.tx({ tenantId }, async (t) => {
    await t.put(MEMORY_HEALTH_DISCLOSURE, key, record);
    await t.audit(
      {
        actor: "agent:shopper-memory",
        action: "memory.health_disclosure.record",
        // PII-safe: only a hashed subjectRef — never the raw account/guest ids.
        input: { subjectRef: subjectRef(tenantId, key, hmacKey) },
        decision: "recorded",
        reversalPath: "n/a — a disclosure is an append-only fact that the shopper was informed; it is not a consent that can be withdrawn (withdrawal is Consent 2 via /consent).",
      },
      at,
    );
  });
}

/**
 * Was health-data carry-over disclosed for this (account, guest) pair? TENANT-SCOPED. Fail-closed: absent
 * record -> false (never true by omission).
 */
export async function lookupHealthDisclosure(store: RuntimeStatePort, input: DisclosureInput): Promise<boolean> {
  const rec = await store.get<DisclosureRecord>({ tenantId: input.tenantId }, MEMORY_HEALTH_DISCLOSURE, disclosureKey(input.accountSubject, input.guestAnonId));
  return rec != null;
}
