import { describe, it, expect } from "vitest";
import type { Decision } from "@palup/widget-brain";
import { buildAuditInput, isGovernanceRelevant } from "../src/audit.js";

// ADR-0016 #2 — the successful AUTONOMOUS skip/pause must land an audit ROW, not merely a flag on the
// Decision. The reviewed (reverted) build was SILENT: its autonomous flags were never governance-relevant,
// so isGovernanceRelevant() returned false and buildAuditInput() returned null — a *regression* versus the
// human-routed skip, which WAS audited. This suite proves the fix at the exact seam that broke: it builds
// the Decision support.ts/brain.ts would actually produce for an autonomous skip/pause/resume/unskip, and
// asserts buildAuditInput returns a REAL row (not null) with the right actor/action/reversalPath — not just
// that a flag happens to be set.

function autonomousSkipDecision(): Decision {
  return {
    mode: "support",
    reply: "Done — I've skipped your next delivery; the order after that will ship as usual. You can undo this anytime — just tell me and I'll put it back.",
    pitch: "none",
    escalateToHuman: false, // auto-executed, NOT escalated — exactly the shape that was silent before
    outbound: false,
    safetyClass: "none",
    flags: ["mode_support", "no_pitch", "support:skip_subscription", "sub_skipped", "autonomous_action", "reversal:unskipNextDelivery"],
    model: "support",
  };
}

function autonomousPauseDecision(): Decision {
  return {
    mode: "support",
    reply: "Done — I've paused your subscription until you say otherwise. You can undo this anytime — just ask and I'll resume it.",
    pitch: "none",
    escalateToHuman: false,
    outbound: false,
    safetyClass: "none",
    flags: ["mode_support", "no_pitch", "support:skip_subscription", "sub_paused", "indefinite_pause", "autonomous_action", "reversal:resumeSubscription"],
    model: "support",
  };
}

function humanRoutedSkipDecision(): Decision {
  return {
    mode: "support",
    reply: "Sure — I can't change the subscription schedule myself, so I've passed your request to skip the next delivery to a member of our team to apply, and flagged it as time-sensitive. They'll confirm once it's set, and the following order would ship as usual.",
    pitch: "none",
    escalateToHuman: true,
    outbound: false,
    safetyClass: "none",
    flags: ["mode_support", "no_pitch", "support:skip_subscription", "skip_sub_routed", "escalate"],
    model: "support",
  };
}

describe("ADR-0016 #2 — the autonomous skip/pause is audited (the fix for the SILENT gap)", () => {
  it("isGovernanceRelevant is TRUE for an autonomous skip Decision (escalateToHuman is FALSE — this is exactly what the reviewed build got wrong)", () => {
    const d = autonomousSkipDecision();
    expect(d.escalateToHuman).toBe(false); // sanity: NOT escalated, so the OLD escalate-only check would have missed it
    expect(isGovernanceRelevant(d)).toBe(true);
  });

  it("buildAuditInput produces a REAL audit ROW (not null) for the autonomous skip Decision — actor/action/reversalPath, not merely a flag", () => {
    const d = autonomousSkipDecision();
    const entry = buildAuditInput({ sessionId: "sess-1", messageLength: 20, servedBy: "champion-v0", decision: d });
    expect(entry).not.toBeNull(); // THE regression: this returned null before
    expect(entry!.actor).toBe("agent:shopper");
    expect(entry!.action).toBe("subscription.skip.autonomous"); // a DISTINCT action, not folded into escalation/refund buckets
    expect(entry!.reversalPath).toMatch(/unskipNextDelivery/); // derived from the decision's OWN reversal:<method> flag
    expect(entry!.reversalPath).not.toBe("n/a — reply only, no state-changing action"); // the generic fallback the reviewed build wrongly used
    expect(entry!.decision).toMatchObject({ mode: "support", escalate: false });
    // No raw shopper message ever lands in the audit input (PII safety, unchanged from the existing contract).
    expect(JSON.stringify(entry)).not.toContain("skipped your next delivery"); // reply text isn't stored, only flags/metadata
  });

  it("buildAuditInput produces a distinct row for an autonomous PAUSE, reversalPath naming resumeSubscription", () => {
    const d = autonomousPauseDecision();
    const entry = buildAuditInput({ sessionId: "sess-2", messageLength: 20, servedBy: "champion-v0", decision: d });
    expect(entry).not.toBeNull();
    expect(entry!.action).toBe("subscription.pause.autonomous");
    expect(entry!.reversalPath).toMatch(/resumeSubscription/);
  });

  it("the HUMAN-ROUTED skip (flag off / unverified / cap / negation) is STILL audited exactly as before (no regression on the existing path)", () => {
    const d = humanRoutedSkipDecision();
    const entry = buildAuditInput({ sessionId: "sess-3", messageLength: 20, servedBy: "champion-v0", decision: d });
    expect(entry).not.toBeNull();
    expect(entry!.action).toBe("money_action.routed_to_human");
    expect(entry!.reversalPath).toBe("handed to a human via escalation");
  });
});
