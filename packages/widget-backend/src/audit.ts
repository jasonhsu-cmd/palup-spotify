import { createHash } from "node:crypto";
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
]);

export function isGovernanceRelevant(d: Decision): boolean {
  return (
    d.escalateToHuman ||
    d.mode === "safety" ||
    d.flags.some((f) => GOVERNANCE_FLAGS.has(f) || f.startsWith("safety:"))
  );
}

function actionFor(d: Decision): string {
  if (d.flags.includes("kill_switch")) return "kill_switch.served";
  if (d.flags.includes("injection_blocked")) return "guardrail.injection_blocked";
  if (d.mode === "safety") return "guardrail.safety";
  if (d.flags.some((f) => f.endsWith("_routed") || f === "refund_hitl")) return "money_action.routed_to_human";
  if (d.flags.includes("giveaway_declined")) return "giveaway.declined";
  if (d.flags.includes("ai_disclosure")) return "ai_identity.disclosed";
  if (d.escalateToHuman) return "escalation.to_human";
  return "guardrail.other";
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
    reversalPath: d.escalateToHuman ? "handed to a human via escalation" : "n/a — reply only, no state-changing action",
  };
}
