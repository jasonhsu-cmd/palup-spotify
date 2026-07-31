import { createHash, createHmac } from "node:crypto";
import type { AuditInput } from "@palup/platform-ports";
import type { Decision } from "@palup/widget-brain";

// Per-turn audit of governance-relevant AUTONOMOUS decisions on the /chat path (NN #5: actor, input,
// decision, reversal path — "no silent actions"). We do NOT audit every benign turn (that would be
// noise + cost); only turns where the agent took a governed action: a guardrail fired, it escalated,
// or it routed a money/fulfilment action. PII SAFETY: the raw shopper message is never written — only
// its length + the decision metadata.

const GOVERNANCE_FLAGS = new Set([
  "kill_switch",
  "injection_blocked",
  "refund_routed",
  "refund_hitl",
  "cancel_routed",
  "cancel_sub_routed",
  "skip_sub_routed",
  "address_change_routed",
  "giveaway_declined",
  "ai_disclosure",
  "offer_human",
  "escalate",
  // ADR-0016 #2 — the successful AUTONOMOUS skip/pause must be audited too, not only the human-routed
  // path above. This was the exact SILENT gap the first (reverted) build shipped: these flags never
  // appeared here, so isGovernanceRelevant() returned false and buildAuditInput() returned null — a
  // *regression* versus the human-routed skip, which WAS audited. `autonomous_action` is a belt-and-
  // suspenders catch-all alongside the `reversal:` prefix check below (either alone is now sufficient).
  "sub_skipped",
  "sub_paused",
  "autonomous_action",
]);

export function isGovernanceRelevant(d: Decision): boolean {
  return (
    d.escalateToHuman ||
    d.mode === "safety" ||
    // ADR-0016 #2 — ANY `reversal:<path>` flag marks a state-changing autonomous action (skip/pause AND
    // its resume/unskip reversal), so it is governance-relevant even without enumerating every possible
    // sub_* flag individually.
    d.flags.some((f) => GOVERNANCE_FLAGS.has(f) || f.startsWith("safety:") || f.startsWith("reversal:"))
  );
}

function actionFor(d: Decision): string {
  if (d.flags.includes("kill_switch")) return "kill_switch.served";
  if (d.flags.includes("injection_blocked")) return "guardrail.injection_blocked";
  if (d.mode === "safety") return "guardrail.safety";
  // ADR-0016 #2 — distinct, unambiguous actions for each autonomous subscription mutation (never folded
  // into the generic "money_action.routed_to_human" below, which is for the HUMAN-routed path only).
  if (d.flags.includes("sub_skipped")) return "subscription.skip.autonomous";
  if (d.flags.includes("sub_paused")) return "subscription.pause.autonomous";
  if (d.flags.includes("sub_resumed")) return "subscription.resume.autonomous";
  if (d.flags.includes("sub_skip_undone")) return "subscription.unskip.autonomous";
  if (d.flags.some((f) => f.endsWith("_routed") || f === "refund_hitl")) return "money_action.routed_to_human";
  if (d.flags.includes("giveaway_declined")) return "giveaway.declined";
  if (d.flags.includes("ai_disclosure")) return "ai_identity.disclosed";
  if (d.escalateToHuman) return "escalation.to_human";
  return "guardrail.other";
}

// ADR-0016 #2/#3 — derive the REAL reversal path from the decision's own `reversal:<method>` flag
// (support.ts sets this from the CommercePort call's actual result), instead of the generic "n/a" the
// reviewed build wrongly used for a state-changing action. Read literally: the audit ROW itself names
// the callable CommercePort method that undoes this action, so "you can undo this" is never an unbacked
// promise even in the audit trail.
function reversalPathFor(d: Decision): string {
  const reversalFlag = d.flags.find((f) => f.startsWith("reversal:"));
  if (reversalFlag) {
    const method = reversalFlag.slice("reversal:".length);
    return `autonomous action is reversible via CommercePort.${method} for this shopper's own subscription`;
  }
  return d.escalateToHuman ? "handed to a human via escalation" : "n/a — reply only, no state-changing action";
}

/**
 * Build the audit record for a /chat decision, or null for a benign turn (no silent-action noise).
 * Pure + PII-safe: no raw shopper message, and the client-supplied sessionId is hashed to an opaque
 * ref so nothing client-placed lands verbatim in the immutable (unredactable) log. The caller commits
 * it — in the SAME transaction as the session-state write (F11) so state never advances without audit.
 */
export function buildAuditInput(args: {
  sessionId: string;
  messageLength: number;
  servedBy: string;
  decision: Decision;
  killScope?: string;
}): AuditInput | null {
  const d = args.decision;
  if (!isGovernanceRelevant(d)) return null;
  const sessionRef = createHash("sha256").update(args.sessionId).digest("hex").slice(0, 16);
  return {
    actor: "agent:shopper",
    action: actionFor(d),
    input: { sessionRef, messageChars: args.messageLength, killScope: args.killScope }, // no raw text, no raw id
    decision: { mode: d.mode, pitch: d.pitch, escalate: d.escalateToHuman, flags: d.flags, servedBy: args.servedBy },
    reversalPath: reversalPathFor(d),
  };
}

// --- ADR-0017 T8 — identity-resolution audit (PII-safe) --------------------------------------------
//
// F7: the shopperId (`shopify:<knownMerchant>:<numeric cid>`) is LOW-ENTROPY — a bare/unsalted hash of
// it is brute-forceable (the merchant is public/known and the customer id space is small per store), so
// the ref MUST be a KEYED HMAC (a server-held secret), never `createHash("sha256")` like `sessionRef`
// above. This makes the ref pseudonymous (recoverable only by whoever holds the key), NOT de-identified.
// The raw shopperId (which embeds the raw numeric customer id) is NEVER written to this audit input, any
// log, or any error message — only the keyed ref.
function hashShopperRef(hmacKey: string, shopperId: string): string {
  return createHmac("sha256", hmacKey).update(shopperId).digest("hex").slice(0, 16);
}

/**
 * Build the `identity.shopper.resolved` audit record for a /chat turn where the shopper resolved to a
 * server-VERIFIED principal (ADR-0017 §4). Read-only identity resolution — never a state-changing
 * action — so the reversal path is explicitly "n/a". Callers MUST NOT call this for an anonymous
 * shopper (no audit noise for the common case, mirrors `isGovernanceRelevant`'s "don't audit every
 * benign turn" policy) — see server.ts, which only calls this after a verified shopper resolves.
 */
export function buildIdentityAuditInput(args: {
  shopperId: string;
  source: "shopify" | "otp";
  tenantId: string;
  hmacKey: string;
}): AuditInput {
  return {
    actor: "system:identity",
    action: "identity.shopper.resolved",
    input: { shopperRef: hashShopperRef(args.hmacKey, args.shopperId), source: args.source, tenantId: args.tenantId }, // NEVER the raw shopperId/customer id
    decision: { verified: true },
    reversalPath: "n/a — read-only identity",
  };
}
