import { createHash } from "node:crypto";
import type { AuditInput } from "@palup/platform-ports";
import type { FactClass } from "./classifier.js";

// ADR-0015 Inv 6 (consent + memory access are audited — no silent memory action) + Inv 5
// (right-to-erasure is audited). Mirrors packages/widget-backend/src/audit.ts's AuditInput shape
// (actor, action, input, decision, reversalPath) and its PII discipline exactly: the raw
// tenant/subject identifier is hashed to an opaque ref (never the raw anonId), and fact TEXT never
// lands in the immutable log — only its sensitivity class and a count.

export type MemoryAction =
  | "consent.granted"
  | "consent.withdrawn"
  | "write.ordinary"
  | "write.special"
  | "recall"
  | "erase.subject"
  | "erase.tenant"
  | "merge"
  | "ttl_sweep"
  | "ttl_renew";

const ACTOR = "agent:shopper-memory";

const REVERSAL_PATHS: Record<MemoryAction, string> = {
  "consent.granted": "shopper may withdraw via the manage-memory / forget-me control",
  "consent.withdrawn": "n/a — withdrawal is itself the reversal; re-granting re-enables writes",
  "write.ordinary": "erase this subject's memory via the vector port (deleteById/deleteNamespace)",
  "write.special": "erase-first: withdrawing Consent 2 purges this fact via the vector port",
  recall: "n/a — read-only, no state change",
  "erase.subject": "n/a — erasure is itself the reversal path (right-to-erasure is irreversible by design)",
  "erase.tenant": "n/a — erasure is itself the reversal path (right-to-erasure is irreversible by design)",
  merge: "irreversible: the pre-merge anon-id namespace is DELETED on merge; the migrated facts live under the account namespace, from which the account's own erasure/withdrawal applies",
  ttl_sweep: "n/a — expiry is policy-driven; a fresh consent grant starts a new TTL",
  "ttl_renew":
    "shopper may withdraw (manage-memory / forget-me) — a withdrawn fact is never renewed again and ages out on its current expiry; erasure purges it immediately",
};

/** Opaque, one-way reference to a subject — NEVER the raw anonId/account id, so the immutable,
 * long-lived audit log can't itself become a re-identification surface. Mirrors
 * widget-backend/src/audit.ts's sessionRef pattern (sha256, truncated). */
function subjectRef(tenantId: string, anonId: string): string {
  return createHash("sha256").update(`${tenantId}::${anonId}`).digest("hex").slice(0, 16);
}

/**
 * Builds the AuditInput for one memory-subsystem action. Actor is always the memory subsystem's own
 * agent identity; input carries only a HASHED subjectRef (never the raw anonId); decision carries only
 * the sensitivity class + a count (NEVER the fact text itself).
 */
export function buildMemoryAudit(args: {
  action: MemoryAction;
  tenantId: string;
  anonId: string;
  factClass?: FactClass;
  count?: number;
}): AuditInput {
  return {
    actor: ACTOR,
    action: args.action,
    input: { subjectRef: subjectRef(args.tenantId, args.anonId) },
    decision: { class: args.factClass, count: args.count ?? 0 },
    reversalPath: REVERSAL_PATHS[args.action],
  };
}
