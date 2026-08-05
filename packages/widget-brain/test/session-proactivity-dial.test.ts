import { describe, it, expect } from "vitest";
import { createBrain, DEFAULT_POLICY, MockModelAdapter, StaticGroundingAdapter } from "../src/index.js";
import { createSession } from "../src/session.js";
import type { Policy, ProactivityLevel, Signals } from "../src/types.js";

// THE DEFECT: a promoted champion's `proactivityDefault` never reached serving. Measured before the fix,
// driving a Session exactly the way server.ts:1336 does (no `level` option passed):
//
//   policy.proactivityDefault=cautious   via-session pitches=2  budgetUsed=2
//   policy.proactivityDefault=balanced   via-session pitches=2  budgetUsed=2
//   policy.proactivityDefault=confident  via-session pitches=2  budgetUsed=2
//
// All three identical, always BUDGET["balanced"] === 2. Expected 1 / 2 / 4.
//
// TWO LINKED CAUSES:
//   (a) `server.ts` built the session as `createSession(brainFor(tenantId, policy), { sessionId, store,
//       autoPersist: false })` — never passing `level`. So `const level = opts.level ?? "balanced"` was
//       ALWAYS "balanced", and INV-E's pitch budget (`BUDGET[level]`) was permanently 2.
//   (b) `send()` then merged `proactivityLevel: signals.proactivityLevel ?? level` into the signals. Since
//       `level` is always defined, that ALWAYS set `signals.proactivityLevel` — which made
//       `brain.ts`'s own `signals.proactivityLevel ?? policy.proactivityDefault` fallback DEAD CODE on
//       every request that goes through a Session. The brain could never see the policy's value.
//
// WHY IT MATTERS MORE THAN A MISSED PITCH: per `docs/adr/0014-*`, the `Policy` type holds ONLY
// `styleDirective` + `proactivityDefault`, so `proactivityDefault` is HALF of everything the
// self-improvement pipeline is capable of changing. An inert dial means a shadow/canary run of a
// proactivity candidate measures NO DIFFERENCE from the incumbent — so it sails through the gate looking
// safe, and then does nothing when promoted. The governance ceremony was guarding an inert lever in both
// directions: a harmful over-messaging change and a beneficial restraint change were equally impossible.

const brainWith = (p: Policy) =>
  createBrain(new MockModelAdapter(), new StaticGroundingAdapter(), p, undefined, "shopper-demo");
const policyAt = (proactivityDefault: ProactivityLevel): Policy => ({ ...DEFAULT_POLICY, proactivityDefault });
const S = { tenantId: "demo", cart: "has_items" };

/** Spend pitches until the session's INV-E budget is exhausted; return how many actually landed. */
async function countPitches(level: ProactivityLevel, opts: { pass: boolean }) {
  const policy = policyAt(level);
  const s = await createSession(brainWith(policy), opts.pass ? { level } : {});
  let pitched = 0;
  for (let i = 0; i < 8; i++) {
    const d = await s.send("what do you recommend for dry skin?", S as never);
    if (d.pitch !== "none") pitched++;
  }
  return { pitched, used: s.state.pitchesUsed };
}

describe("the proactivity dial reaches the session budget (INV-E)", () => {
  // BUDGET in session.ts: cautious 1, balanced 2, confident 4.
  const expected: [ProactivityLevel, number][] = [
    ["cautious", 1],
    ["balanced", 2],
    ["confident", 4],
  ];

  it.each(expected)("an explicit level %s spends exactly %i pitches", async (level, n) => {
    const { pitched, used } = await countPitches(level, { pass: true });
    expect(pitched).toBe(n);
    expect(used).toBe(n);
  });

  it("THE DEFECT: the three levels must not all behave identically", async () => {
    const [c, b, f] = await Promise.all([
      countPitches("cautious", { pass: true }),
      countPitches("balanced", { pass: true }),
      countPitches("confident", { pass: true }),
    ]);
    expect(new Set([c.pitched, b.pitched, f.pitched]).size, "the dial is inert — all levels behave the same").toBe(3);
    expect(c.pitched).toBeLessThan(b.pitched);
    expect(b.pitched).toBeLessThan(f.pitched);
  });
});

describe("with NO explicit level, the brain's own policy fallback must be reachable", () => {
  // This is cause (b). The session used to inject `proactivityLevel` unconditionally, so the brain's
  // `signals.proactivityLevel ?? policy.proactivityDefault` could never take its right-hand branch.
  const seen: (ProactivityLevel | undefined)[] = [];
  const recordingBrain = (p: Policy) => {
    const inner = brainWith(p);
    return {
      async decide(signals: Signals, message: string, history?: never) {
        seen.push(signals.proactivityLevel);
        return inner.decide(signals, message, history);
      },
    };
  };

  it("does NOT stamp proactivityLevel onto the signals when the caller gave no level", async () => {
    seen.length = 0;
    const s = await createSession(recordingBrain(policyAt("confident")) as never, {});
    await s.send("hello", S as never);
    expect(seen[0], "an unconditional stamp makes brain.ts's policy fallback dead code").toBeUndefined();
  });

  it("DOES stamp it when the caller gave one explicitly", async () => {
    seen.length = 0;
    const s = await createSession(recordingBrain(policyAt("balanced")) as never, { level: "cautious" });
    await s.send("hello", S as never);
    expect(seen[0]).toBe("cautious");
  });

  it("a caller-supplied signal still wins over the session's level (unchanged precedence)", async () => {
    seen.length = 0;
    const s = await createSession(recordingBrain(policyAt("balanced")) as never, { level: "cautious" });
    await s.send("hello", { ...S, proactivityLevel: "confident" } as never);
    expect(seen[0]).toBe("confident");
  });
});

describe("the budget survives a restore, so the dial cannot be reset by reconnecting", () => {
  it("a restored session keeps its spent budget and its level", async () => {
    const rows = new Map<string, unknown>();
    const store = {
      async load(id: string) { return rows.get(id) as never; },
      async save(id: string, st: unknown) { rows.set(id, st); },
    };
    const policy = policyAt("cautious");

    const a = await createSession(brainWith(policy), { sessionId: "s1", store: store as never, level: "cautious" });
    const d1 = await a.send("what do you recommend for dry skin?", S as never);
    expect(d1.pitch).not.toBe("none"); // spends the single cautious pitch

    // Reconnect: a new Session over the SAME persisted state must not hand out a fresh budget.
    const b = await createSession(brainWith(policy), { sessionId: "s1", store: store as never, level: "cautious" });
    expect(b.state.pitchesUsed).toBe(1);
    const d2 = await b.send("what else would you suggest?", S as never);
    expect(d2.pitch, "reconnecting refilled the pitch budget").toBe("none");
  });
});
