import { describe, it, expect } from "vitest";
import { buildOpenerAuditInput } from "../src/audit.js";
import type { Decision } from "@palup/widget-brain";

// §3.5 — the proactive OPENER is agent-initiated and shopper-reaching, so it is logged even though it is a
// benign smalltalk turn that buildAuditInput deliberately skips. PII-safe: the client sessionId is hashed to
// an opaque ref, and only the CODE-OWNED chip actions + a card flag are recorded — never a label, catalog
// text, or a shopper message.

function openerDecision(over: Partial<Decision> = {}): Decision {
  return {
    mode: "smalltalk",
    reply: "Hi! Looking for something in particular?",
    pitch: "none",
    escalateToHuman: false,
    outbound: false,
    safetyClass: "none",
    flags: ["proactive:greeting", "opener"],
    suggestedChips: [
      { label: "Find my match", action: "find_my_match" },
      { label: "See our bestsellers", action: "bestsellers" },
    ],
    ...over,
  } as Decision;
}

describe("buildOpenerAuditInput (§3.5 — the proactive opener is audited, PII-safe)", () => {
  it("emits opener.served with a hashed sessionRef, the enum chip actions, a card flag, and n/a reversal", () => {
    const sessionId = "sess-abc-123-should-never-appear";
    const entry = buildOpenerAuditInput({ sessionId, decision: openerDecision({ flags: ["proactive:greeting", "opener", "opener:card"] }) });
    expect(entry.actor).toBe("agent:shopper");
    expect(entry.action).toBe("opener.served");
    expect(entry.reversalPath).toContain("n/a");
    // the raw client sessionId is NEVER in the immutable record — only a 16-hex sha256 slice
    expect(JSON.stringify(entry)).not.toContain(sessionId);
    const input = entry.input as { sessionRef: string; chips: string[]; carded: boolean };
    expect(input.sessionRef).toMatch(/^[0-9a-f]{16}$/);
    expect(input.chips).toEqual(["find_my_match", "bestsellers"]); // closed-enum actions only
    expect(input.carded).toBe(true);
  });

  it("carded is false when the opener served no product card", () => {
    const entry = buildOpenerAuditInput({ sessionId: "s", decision: openerDecision({ flags: ["proactive:greeting", "opener"] }) });
    expect((entry.input as { carded: boolean }).carded).toBe(false);
  });

  it("records NO chip labels or catalog text — only the enum actions (labels are merchant/product-adjacent)", () => {
    const serialized = JSON.stringify(buildOpenerAuditInput({ sessionId: "s", decision: openerDecision() }));
    expect(serialized).not.toContain("Find my match");
    expect(serialized).not.toContain("See our bestsellers");
  });

  it("the hashed sessionRef is deterministic for the same sessionId (correlatable by seq, without the raw id)", () => {
    const a = buildOpenerAuditInput({ sessionId: "same", decision: openerDecision() });
    const b = buildOpenerAuditInput({ sessionId: "same", decision: openerDecision() });
    expect((a.input as { sessionRef: string }).sessionRef).toBe((b.input as { sessionRef: string }).sessionRef);
  });
});
