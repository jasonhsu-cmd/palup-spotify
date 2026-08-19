import { describe, it, expect } from "vitest";
import {
  createBrain,
  MockModelAdapter,
  StaticGroundingAdapter,
  MockCommerceAdapter,
  DEFAULT_POLICY,
} from "../src/index.js";
import type { ModelPort } from "@palup/platform-ports";

// Pillar 3 slice 3 — the §5 proactive OPENER. It UPGRADES the WS6 greeting (fit-first sentence + tappable
// chips) but must stay NON-COMMERCIAL by construction, exactly like the greeting it extends: pitch:"none",
// never a money-gated pitch, and chips carrying only code-owned, closed-enum, non-commercial labels — across
// every relationship × mood × cart. A discount that slips into the reply trips the reply-integrity backstop.
// This mirrors select-pitch-money-boundary.test.ts / greeting-money-boundary.test.ts for the opener path.

// createBrain positional tail: … greetingProactiveEnabled(24), channelHealthFor(25),
// priceRequiresLiveChannelEnabled(26), proactiveOpenerEnabled(27). Enable the greeting AND the opener.
function openerBrain(model: ModelPort = new MockModelAdapter()) {
  return createBrain(
    model, new StaticGroundingAdapter(), DEFAULT_POLICY, new MockCommerceAdapter(), "shopper-demo",
    undefined, undefined, undefined, undefined, undefined, // memory, subscription, disposition×3
    undefined, undefined, undefined, undefined, undefined, undefined, // catalogRetriever, retrievalEnabled, K, citations, cards, cartLineItems
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, // serverGuard, factsPort, hydration, offerModel, offerCheck, maxAge, turnEmbedder
    true, // greetingProactiveEnabled (24)
    undefined, // channelHealthFor (25)
    undefined, // priceRequiresLiveChannelEnabled (26)
    true, // proactiveOpenerEnabled (27)
  );
}
const OPEN = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  tenantId: "demo",
  proactiveTrigger: "greeting",
  mood: "neutral",
  ...extra,
});
const COMMERCIAL = /(\d+\s*%|percent|discount|coupon|promo\b|sale\b|% ?off|buy ?now|save\b|deal\b|limited|hurry|last chance|only .* left)/i;
const CHIP_ACTIONS = ["find_my_match", "bestsellers", "new_here"];

describe("Pillar 3 — opener money boundary (non-commercial by construction)", () => {
  for (const relationship of ["anonymous", "new"]) {
    for (const mood of ["neutral", "satisfied"]) {
      for (const cart of [undefined, "has_items"]) {
        it(`opener stays pitch:none + code-owned non-commercial chips (rel=${relationship} mood=${mood} cart=${cart})`, async () => {
          const brain = openerBrain();
          const d = await brain.decide(OPEN({ relationship, mood, cart }) as never, "");
          expect(d.pitch).toBe("none");
          expect(d.outbound).toBe(false);
          expect(d.escalateToHuman).toBe(false);
          expect(d.flags).toContain("opener");
          expect(d.flags).toContain("proactive:greeting");
          expect(Array.isArray(d.suggestedChips)).toBe(true);
          expect(d.suggestedChips!.length).toBeGreaterThan(0);
          for (const c of d.suggestedChips!) {
            expect(CHIP_ACTIONS).toContain(c.action); // closed enum
            expect(typeof c.label).toBe("string");
            expect(c.label).not.toMatch(COMMERCIAL); // code-owned label is never commercial
          }
          expect(d).not.toHaveProperty("recommendedProducts"); // 3a has no card yet (that's 3b)
        });
      }
    }
  }

  it("an opener that tries to smuggle a discount trips the reply-integrity backstop — no reply leak, no chips", async () => {
    const brain = openerBrain({ complete: async () => ({ text: "Welcome! Here's 30% off today only — buy now!", model: "spy" }) });
    const d = await brain.decide(OPEN() as never, "");
    expect(d.pitch).toBe("none");
    expect(d.reply).not.toMatch(/30\s*%\s*off/i); // discountGuardrail replaced the smuggled discount
    expect(d).not.toHaveProperty("suggestedChips"); // the guardrail return carries no opener affordances
  });

  it("at cap (§8a inv-14) → QUIET even with the opener on: empty reply, no chips, zero model spend", async () => {
    let calls = 0;
    const counting: ModelPort = { complete: async () => (calls++, { text: "should not be called", model: "spy" }) };
    const brain = openerBrain(counting);
    const d = await brain.decide(OPEN({ atCap: true }) as never, "");
    expect(d.reply).toBe("");
    expect(d.pitch).toBe("none");
    expect(calls).toBe(0);
    expect(d).not.toHaveProperty("suggestedChips");
  });

  it("a negative-mood shopper (frustrated/upset/anxious) gets the plain warm greeting, NOT the upbeat opener chips", async () => {
    for (const mood of ["frustrated", "upset", "anxious"]) {
      const brain = openerBrain();
      const d = await brain.decide(OPEN({ mood }) as never, "");
      expect(d.pitch).toBe("none"); // still non-commercial
      expect(d.flags).not.toContain("opener"); // opener withheld
      expect(d).not.toHaveProperty("suggestedChips"); // no upbeat chips to a frustrated shopper
      expect(d.reply.length).toBeGreaterThan(0); // but a warm greeting still lands
    }
  });
});
