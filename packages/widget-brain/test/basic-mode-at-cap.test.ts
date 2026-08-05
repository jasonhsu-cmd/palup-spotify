import { describe, it, expect } from "vitest";
import { createBrain, DEFAULT_POLICY, MockModelAdapter, StaticGroundingAdapter } from "../src/index.js";

// §8a INVARIANT 14 — Basic-mode-at-cap. `docs/design/shopper-widget.md:210`:
//
//   | 14 | Basic-mode-at-cap | at billing cap | no proactive; live chat continues; customer never sees
//        billing state | compliance |
//
// and `docs/AGENT-GOVERNANCE.md:114`: "Cost circuit-breaker: spend beyond budget freezes the agent and
// raises an alert."
//
// BEFORE THIS: entirely absent. Searched all of packages/ for atCap / basicMode / billingCap / at_cap —
// zero non-test hits — and the 66-case corpus had no case mentioning a cap. Spend was measured only in the
// control plane (`deriveCostUsd(rollup, loadModelPrices())`), and nothing turned it into a signal serving
// could read. Invariant 14 was listed, labelled `compliance`, and unimplemented.
//
// THE THREE CLAUSES ARE INDEPENDENT, AND THE MIDDLE ONE IS THE ONE THAT GETS LOST:
//   1. NO PROACTIVE      — the agent must stop initiating. Easy, and the only part a naive "just halt it"
//                          implementation gets right.
//   2. LIVE CHAT CONTINUES — a shopper mid-conversation must still be answered. Their merchant's billing
//                          state is not their problem. Reusing the KILL switch here would fail this
//                          clause, which is exactly why this is a separate signal and a separate registry.
//   3. NEVER VISIBLE      — no reply may mention billing, plans, limits, quotas, or usage. The shopper is
//                          not told, and not hinted at.

const mk = () => createBrain(new MockModelAdapter(), new StaticGroundingAdapter(), DEFAULT_POLICY, undefined, "shopper-demo");
const CART = { tenantId: "demo", cart: "has_items" as const };

/** Anything that would leak a merchant's commercial state to a shopper. */
const BILLING_LEAK = /billing|invoice|plan|quota|usage limit|spend|budget|credit|cap\b|subscription (?:limit|tier)|upgrade (?:your|their) plan|out of (?:credits|messages)|rate.?limit/i;

describe("clause 1 — at cap, the agent never initiates", () => {
  it("a proactive exit-intent trigger goes QUIET at cap", async () => {
    const d = await mk().decide({ ...CART, proactiveTrigger: "exit_intent", atCap: true } as never, "");
    expect(d.pitch).toBe("none");
    expect(d.reply).toBe("");
    expect(d.outbound).toBe(false);
    expect(d.flags).toContain("at_cap");
    expect(d.flags).toContain("no_pitch");
  });

  it("the SAME trigger without the cap does produce the cart-recovery nudge — so the brake is what changed", async () => {
    const d = await mk().decide({ ...CART, proactiveTrigger: "exit_intent" } as never, "");
    expect(d.pitch).toBe("cart_recovery");
  });

  it("at cap outranks a healthy cart and a positive mood — the tempting case", async () => {
    const d = await mk().decide(
      { ...CART, cart: "high_value", mood: "satisfied", proactiveTrigger: "exit_intent", atCap: true } as never,
      "",
    );
    expect(d.pitch).toBe("none");
    expect(d.flags).toContain("at_cap");
  });

  it("the at-cap event is observable in the flags, so it reaches the audit record (NN#5)", async () => {
    const d = await mk().decide({ ...CART, proactiveTrigger: "exit_intent", atCap: true } as never, "");
    // docs/design/shopper-widget.md:232 lists "at-cap basic-mode" among the events that must be logged.
    expect(d.flags).toContain("at_cap");
  });
});

describe("clause 2 — live chat continues (the clause a kill switch would break)", () => {
  const reactive: [string, Record<string, unknown>][] = [
    ["what's your return policy?", {}],
    ["do you have a fragrance-free moisturizer?", {}],
    ["my order arrived damaged", {}],
    ["I used it and my face is burning", {}],
    ["am I ok to use this while pregnant?", {}],
    ["are you a real person?", {}],
  ];

  it.each(reactive)("%s is still answered at cap", async (message, extra) => {
    const d = await mk().decide({ ...CART, ...extra, atCap: true } as never, message);
    expect(d.reply.length, "a shopper was left unanswered at cap").toBeGreaterThan(0);
  });

  it("a safety report at cap STILL escalates — cost never suppresses safety", async () => {
    const d = await mk().decide({ ...CART, atCap: true } as never, "I used it and my face is burning and swelling");
    expect(d.mode).toBe("safety");
    expect(d.escalateToHuman).toBe(true);
    expect(d.pitch).toBe("none");
  });

  it("a support request at cap still routes to support", async () => {
    const d = await mk().decide({ ...CART, atCap: true } as never, "my order arrived damaged");
    expect(d.mode).toBe("support");
  });

  it("the kill switch and the cap are DIFFERENT: kill halts, cap keeps serving", async () => {
    const killed = await mk().decide({ ...CART, kill: true } as never, "do you have a moisturizer?");
    const capped = await mk().decide({ ...CART, atCap: true } as never, "do you have a moisturizer?");
    expect(killed.flags).toContain("kill_switch");
    expect(killed.flags).toContain("no_autonomous_action");
    // At cap the shopper is served a normal answer; under kill they are handed to a person.
    expect(capped.flags).not.toContain("kill_switch");
    expect(capped.flags).not.toContain("no_autonomous_action");
    expect(capped.mode).not.toBe("support");
  });
});

describe("clause 3 — the shopper never sees the merchant's billing state", () => {
  const probes = [
    "why aren't you suggesting anything?",
    "is something wrong with the chat?",
    "are you limited right now?",
    "hello?",
    "what's your return policy?",
    "why did you stop recommending products?",
  ];

  it.each(probes)("%s -> reply mentions no billing state", async (message) => {
    const d = await mk().decide({ ...CART, atCap: true } as never, message);
    expect(d.reply, `leaked commercial state: ${d.reply}`).not.toMatch(BILLING_LEAK);
  });

  it("the QUIET proactive turn carries no reply text at all, so nothing can leak through it", async () => {
    const d = await mk().decide({ ...CART, proactiveTrigger: "exit_intent", atCap: true } as never, "");
    expect(d.reply).toBe("");
  });

  it("the at_cap FLAG is operator-facing only — it is not a reply and not shopper-visible", async () => {
    // The flag must exist for the audit trail (clause 1's test) while never becoming shopper text. The
    // widget renders `reply`, never `flags`; this pins that the flag name itself never leaks into reply.
    const d = await mk().decide({ ...CART, atCap: true } as never, "why aren't you suggesting anything?");
    expect(d.reply).not.toMatch(/at_cap|basic mode|basic-mode/i);
  });
});

describe("atCap is a SUPPRESSOR only — it can never grant anything", () => {
  it("does not resurrect a pitch that another brake already disallowed", async () => {
    // Empty cart already means quiet; adding atCap must not change that into a pitch.
    const d = await mk().decide(
      { tenantId: "demo", cart: "empty", proactiveTrigger: "exit_intent", atCap: true } as never,
      "",
    );
    expect(d.pitch).toBe("none");
  });

  it("does not lift the safety latch", async () => {
    const d = await mk().decide({ ...CART, safetyLatched: true, atCap: true } as never, "add the cleanser to my cart");
    expect(d.mode).toBe("safety");
    expect(d.pitch).toBe("none");
  });

  it("atCap:false is identical to omitting it", async () => {
    const a = await mk().decide({ ...CART, proactiveTrigger: "exit_intent", atCap: false } as never, "");
    const b = await mk().decide({ ...CART, proactiveTrigger: "exit_intent" } as never, "");
    expect(a.pitch).toBe(b.pitch);
    expect(a.flags).not.toContain("at_cap");
  });
});
