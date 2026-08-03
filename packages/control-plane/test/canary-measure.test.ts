import { describe, it, expect } from "vitest";
import type { Interaction } from "../src/canary-controller.js";
import { measureCanary, escalationRegressed } from "../src/canary-measure.js";

// ADR-0014 T4e — the REAL canary measurement (owner chose to build the method now, not a placeholder):
// the 1-5% canary-served-vs-champion QUALITY delta (cross-family judge re-grade of each arm's ACTUAL
// replies) + escalation rate, over the observation window from the tenant's traffic log. n (for
// statistical power) is the FULL canary-served count; quality is a sampled re-grade. Return/complaint/
// opt-out are POST-PURCHASE signals absent from the in-window stream — the delayed-signal domain (T3).

const mk = (servedBy: string, reply: string, escalate: boolean, ts = "2026-08-02T12:00:00Z"): Interaction => ({
  ts, servedBy, sessionId: "s", message: "do you have a moisturizer for dry skin?", reply, mode: "sales", escalate,
});
// A deterministic stand-in for the cross-family judge: score = 1 if the reply contains "good", else 0.
const grade = async (reply: string) => (reply.includes("good") ? 1 : 0);
const ARMS = { canaryPolicyId: "canary-warm", championPolicyId: "champion-v0" };
const WINDOW = { since: "2026-08-01T00:00:00Z", now: "2026-08-03T00:00:00Z" };

describe("measureCanary (ADR-0014 T4e: live canary-vs-champion quality + escalation over the window)", () => {
  it("computes qualityDelta from each arm's real replies, full n for power, and per-arm escalation rate", async () => {
    const traffic: Interaction[] = [
      mk("canary-warm", "a good recommendation", false),
      mk("canary-warm", "a good pick for you", false),
      mk("canary-warm", "meh", true), // canary escalates once
      mk("champion-v0", "a good option", false),
      mk("champion-v0", "meh", false),
    ];
    const m = await measureCanary(traffic, grade, ARMS, WINDOW, 20);
    expect(m.n).toBe(3); // full canary-served count (power), not the sample cap
    expect(m.championN).toBe(2);
    expect(m.canaryQuality).toBeCloseTo(2 / 3); // 2 of 3 contain "good"
    expect(m.championQuality).toBeCloseTo(1 / 2);
    expect(m.qualityDelta).toBeCloseTo(2 / 3 - 1 / 2);
    expect(m.canaryEscalationRate).toBeCloseTo(1 / 3);
    expect(m.championEscalationRate).toBe(0);
    expect(m.elapsedMs).toBe(Date.parse(WINDOW.now) - Date.parse(WINDOW.since));
  });

  it("excludes traffic before the window start and trivially-short messages", async () => {
    const traffic: Interaction[] = [
      mk("canary-warm", "a good one", false, "2026-07-01T00:00:00Z"), // before `since` → excluded
      mk("canary-warm", "a good two", false, "2026-08-02T00:00:00Z"),
      { ...mk("canary-warm", "a good three", false, "2026-08-02T00:00:00Z"), message: "?" }, // too short → excluded
    ];
    const m = await measureCanary(traffic, grade, ARMS, WINDOW, 20);
    expect(m.n).toBe(1); // only the in-window, non-trivial canary interaction
  });

  it("empty arm ⇒ zero quality and zero count (no divide-by-zero)", async () => {
    const m = await measureCanary([mk("champion-v0", "a good option", false)], grade, ARMS, WINDOW, 20);
    expect(m.n).toBe(0);
    expect(m.canaryQuality).toBe(0);
    expect(m.qualityDelta).toBeCloseTo(-1); // champion 1, canary 0
  });

  it("escalationRegressed flags a canary that escalates MEANINGFULLY LESS than the champion (recall drop)", () => {
    // escalation recall is higher-is-better; a canary that escalates less may be missing required escalations
    expect(escalationRegressed({ canaryEscalationRate: 0.1, championEscalationRate: 0.5 } as never, 0.1)).toBe(true);
    expect(escalationRegressed({ canaryEscalationRate: 0.45, championEscalationRate: 0.5 } as never, 0.1)).toBe(false); // within tolerance
    expect(escalationRegressed({ canaryEscalationRate: 0.6, championEscalationRate: 0.5 } as never, 0.1)).toBe(false); // escalates more ⇒ fine
  });
});
