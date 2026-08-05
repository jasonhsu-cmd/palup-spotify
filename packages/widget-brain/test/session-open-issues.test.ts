import { describe, it, expect } from "vitest";
import { createBrain, DEFAULT_POLICY, MockModelAdapter, StaticGroundingAdapter } from "../src/index.js";
import { createSession, CONFIRMED_RESOLVED, PLEASANTRIES, isResolutionConfirmed } from "../src/session.js";

// THREE DEFECTS IN THE SESSION'S OPEN-ISSUE LEDGER, all verified by execution before the fix.
//
// (1) A BARE PLEASANTRY WIPES AN UNRESOLVED COMPLAINT, AND THAT RE-ARMS PITCHING.
//     `RESOLUTION` (session.ts:10) contained "thanks", "thank you", "got it" and "perfect" — pure
//     pleasantries, not resolution confirmations. Any one of them cleared EVERY open issue. Measured:
//
//       "the bottle arrived cracked and leaking"  -> support, openIssues ["damaged"], pitch none
//       "thanks"                                  -> openIssues []
//       "do you have a bigger size of the serum?" -> mode SALES, pitch CROSS_SELL
//
//     Saying the same three turns with "ok" in place of "thanks" stays `support` / `no_pitch`. So the
//     single word "thanks" is what let the agent start cross-selling to a shopper holding a broken,
//     leaking product. That is spec §8a invariant 13 (restraint — "no pitch into complaint; resolve
//     first") failing on the most ordinary thing a polite shopper says.
//
// (2) THE LEDGER COULD NEVER HOLD MORE THAN ONE ISSUE.
//     `else if (!merged.openIssues?.length)` recorded an issue ONLY when none was open, so a second,
//     different problem was silently dropped. Measured: turn 1 "my order arrived late" -> ["order_status"];
//     turn 2 "also the bottle arrived cracked and leaking" -> STILL ["order_status"]. The damage was never
//     recorded. support.ts:530-534 renders multiple issues ("your X and your Y", "on them", "either") —
//     that code was unreachable, because state could never contain two.
//
// (3) `signals.handoff` HAS NO PRODUCTION PRODUCER — the recurring "correct code, no caller" shape.
//     It is declared (types.ts:184), consumed (session.ts:222 clears escalationPending), and set only in
//     tests. `deriveServingSignals` does not accept it from the client, the widget never sends it, and no
//     server route sets it. So `escalationPending` never clears in production, and `safetyLatched` never
//     clears at all. Both are FAIL-SAFE, so neither is a live harm — this suite pins them that way rather
//     than "fixing" them, and pins the trust boundary so nobody later wires `handoff` to client input and
//     turns it into a safety-latch bypass.

const mk = () => createBrain(new MockModelAdapter(), new StaticGroundingAdapter(), DEFAULT_POLICY, undefined, "shopper-demo");
const S = { tenantId: "demo", cart: "has_items" };

describe("a pleasantry is not a resolution — restraint survives politeness (§8a inv 13)", () => {
  // Every one of these cleared the ledger before the fix.
  const pleasantries = ["thanks", "thank you", "thanks!", "got it", "perfect", "ok thanks", "cheers"];

  it.each(pleasantries)("%s does NOT close an unresolved damage complaint", async (phrase) => {
    const s = await createSession(mk());
    await s.send("the bottle arrived cracked and leaking", S as never);
    expect(s.state.openIssues).toEqual(["damaged"]);
    await s.send(phrase, S as never);
    expect(s.state.openIssues, `"${phrase}" wiped the open issue`).toEqual(["damaged"]);
  });

  it("THE DEFECT: after a pleasantry the agent still must not pitch", async () => {
    const s = await createSession(mk());
    await s.send("the bottle arrived cracked and leaking", S as never);
    await s.send("thanks", S as never);
    const d = await s.send("do you have a bigger size of the serum?", S as never);

    expect(d.mode).toBe("support");
    expect(d.pitch).toBe("none");
    expect(d.flags).toContain("no_pitch");
  });

  // The control: an ACTUAL confirmation must still close the issue, or the agent can never move on and
  // the shopper is stuck in support mode for the rest of the session.
  const confirmations = ["that fixed it", "all sorted now", "that's resolved", "all set now", "yes that worked"];

  it.each(confirmations)("%s DOES close it", async (phrase) => {
    const s = await createSession(mk());
    await s.send("the bottle arrived cracked and leaking", S as never);
    await s.send(phrase, S as never);
    expect(s.state.openIssues, `"${phrase}" should have closed the issue`).toEqual([]);
  });

  it("a pleasantry ATTACHED to a real confirmation still closes it", async () => {
    const s = await createSession(mk());
    await s.send("the bottle arrived cracked and leaking", S as never);
    await s.send("thanks, that fixed it", S as never);
    expect(s.state.openIssues).toEqual([]);
  });

  it("a confirmation does NOT close an issue the same turn also reports", async () => {
    const s = await createSession(mk());
    await s.send("my order is late", S as never);
    // "all sorted" on the late order, but a NEW problem arrives in the same breath.
    await s.send("the shipping is all sorted now but the bottle arrived cracked", S as never);
    expect(s.state.openIssues).toContain("damaged");
  });
});

describe("the ledger is a SET of distinct issues, not a single slot", () => {
  it("THE DEFECT: a second, different problem is recorded, not dropped", async () => {
    const s = await createSession(mk());
    await s.send("my order arrived late", S as never);
    expect(s.state.openIssues).toEqual(["order_status"]);

    await s.send("also the bottle arrived cracked and leaking", S as never);
    expect(s.state.openIssues).toContain("order_status");
    expect(s.state.openIssues).toContain("damaged");
  });

  it("the SAME issue restated does not duplicate", async () => {
    const s = await createSession(mk());
    await s.send("the bottle arrived cracked", S as never);
    await s.send("the bottle is still cracked and leaking everywhere", S as never);
    expect(s.state.openIssues).toEqual(["damaged"]);
  });

  it("is deduped on restore from a persisted record that already holds duplicates", async () => {
    // A record written by the pre-fix code (or any future bug) must not resurrect duplicates.
    const store = {
      rows: new Map<string, unknown>([["s1", { safetyLatched: false, openIssues: ["damaged", "damaged", "order_status"], pitchesUsed: 0, escalationPending: false, resumeOffered: false, pitchDeclined: false, repeatQuestionCount: 0, rageCount: 0 }]]),
      async load(id: string) { return this.rows.get(id) as never; },
      async save(id: string, st: unknown) { this.rows.set(id, st); },
    };
    const s = await createSession(mk(), { sessionId: "s1", store: store as never });
    expect(s.state.openIssues).toEqual(["damaged", "order_status"]);
  });

  it("multiple open issues reach the support reply — the multi-issue branch is reachable now", async () => {
    const s = await createSession(mk());
    await s.send("my order arrived late", S as never);
    await s.send("also the bottle arrived cracked and leaking", S as never);
    // support.ts renders "your X and your Y" + "on them" / "either" only when length > 1.
    expect(s.state.openIssues.length).toBeGreaterThan(1);
    const d = await s.send("any update?", S as never);
    expect(d.mode).toBe("support");
    expect(d.pitch).toBe("none");
  });

  it("a bounded ledger — a shopper cannot grow it without limit", async () => {
    const s = await createSession(mk());
    for (let i = 0; i < 40; i++) {
      await s.send(`problem number ${i}: my order is late and the box was damaged and it never shipped`, S as never);
    }
    // Distinct intent labels are few; the point is that it stays bounded and deduped.
    expect(s.state.openIssues.length).toBeLessThanOrEqual(8);
    expect(new Set(s.state.openIssues).size).toBe(s.state.openIssues.length);
  });
});

describe("the safety latch is deliberately permanent, and handoff is not client-reachable", () => {
  it("safetyLatched never clears — not on a resolution, not on a claimed handoff", async () => {
    const s = await createSession(mk());
    await s.send("my face is burning", S as never);
    expect(s.state.safetyLatched).toBe(true);

    await s.send("all sorted now", S as never);
    expect(s.state.safetyLatched, "a resolution phrase must not lift a safety latch").toBe(true);

    await s.send("thanks", { ...S, handoff: true } as never);
    expect(s.state.safetyLatched, "even a handoff must not lift a safety latch (INV-A)").toBe(true);
  });

  it("a latched session cannot be pitched to, whatever it says next", async () => {
    const s = await createSession(mk());
    await s.send("my face is burning", S as never);
    for (const m of ["thanks", "all sorted now", "do you have a bigger size?", "add the cleanser to my cart"]) {
      const d = await s.send(m, { ...S, handoff: true } as never);
      expect(d.mode, `"${m}" escaped the safety latch`).toBe("safety");
      expect(d.pitch).toBe("none");
    }
  });
});

describe("the pleasantry/confirmation distinction cannot be quietly undone", () => {
  it("no pleasantry is, or contains, a resolution confirmation", () => {
    // This is the guard on the fix itself. Sliding "thanks" back into CONFIRMED_RESOLVED — or adding a
    // confirmation phrase so loose that a bare pleasantry matches it — reintroduces the exact defect,
    // and would otherwise only show up as one of the behavioural tests above going quietly wrong.
    for (const p of PLEASANTRIES) {
      expect(CONFIRMED_RESOLVED, `"${p}" is listed as a confirmation`).not.toContain(p);
      expect(
        CONFIRMED_RESOLVED.filter((c) => p.includes(c)),
        `pleasantry "${p}" matches confirmation phrase(s)`,
      ).toEqual([]);
    }
  });

  it("every confirmation phrase actually confirms, and every pleasantry actually does not", () => {
    for (const c of CONFIRMED_RESOLVED) expect(isResolutionConfirmed(`ok ${c}`), c).toBe(true);
    for (const p of PLEASANTRIES) expect(isResolutionConfirmed(p), p).toBe(false);
  });
});
