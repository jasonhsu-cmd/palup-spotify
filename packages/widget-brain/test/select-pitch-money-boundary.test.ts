import { describe, it, expect, vi } from "vitest";
import type { ModelPort } from "@palup/platform-ports";
import {
  createBrain,
  DEFAULT_POLICY,
  StaticGroundingAdapter,
  MockCommerceAdapter,
  MONEY_GATED_PITCHES,
} from "../src/index.js";
import type { Relationship, ProactivityLevel } from "../src/index.js";

// STRUCTURAL pitch hardening (moat / NN#1). The reactive pitch selector must NEVER autonomously
// emit a money-moving pitch — `upsell`, `subscription`, `promo` all change plan/price/promotion
// (docs/HITL-POLICY.md Q1), so they are reachable ONLY through a human-approved enablement path
// (Approval Center; SUBSCRIPTION_SELFSERVE ADR-0016; grounded merchant promos), never by the
// autonomous selector. selectPitch already satisfies this incidentally; this test makes it a
// STRUCTURAL, CI-enforced invariant so a future pitch branch cannot cross the money boundary
// unnoticed (§3 — the OpenClaw failure mode PalUp exists to prevent). It drives the PUBLIC
// decide() pitch surface (selectPitch is module-internal, tested via decide() everywhere else),
// so it also covers the whole reactive path, not just the selector.

function spyBrain() {
  const spy = vi.fn<ModelPort["complete"]>(async () => ({ text: "ok", model: "spy" }));
  const brain = createBrain(
    { complete: spy },
    new StaticGroundingAdapter(),
    DEFAULT_POLICY,
    new MockCommerceAdapter(),
    "shopper-demo",
  );
  return brain;
}

// WS-C — a flag-ON brain. `autonomousMoneyPitchesEnabled` is passed as a `createBrain` GUARDRAIL
// argument (position 29), never as a `Policy` field, matching brain.ts's param comment. All positions
// between the flag-off spyBrain()'s args and this one are left at their createBrain defaults (undefined
// ports / false flags) — none of them interact with selectPitch, so this only differs from spyBrain() in
// exactly the one dimension under test.
function spyBrainMoneyPitchesOn() {
  const spy = vi.fn<ModelPort["complete"]>(async () => ({ text: "ok", model: "spy" }));
  const brain = createBrain(
    { complete: spy },
    new StaticGroundingAdapter(),
    DEFAULT_POLICY,
    new MockCommerceAdapter(),
    "shopper-demo",
    undefined, // memory
    false, // subscriptionSelfServeEnabled
    false, // dispositionStyleEnabled
    false, // dispositionBehavioralEnabled
    false, // dispositionClassifierEnabled
    undefined, // catalogRetriever
    false, // catalogRetrievalEnabled
    undefined, // catalogRetrievalK
    false, // productCitationsEnabled
    false, // productCardsEnabled
    false, // cartLineItemsEnabled
    false, // serverGuardSignalsEnabled
    undefined, // productFactsPort
    false, // productFactsHydrationEnabled
    undefined, // offerCheckModel
    false, // outgoingOfferCheckEnabled
    undefined, // productFactsMaxAgeMs
    undefined, // turnEmbedder
    false, // greetingProactiveEnabled
    undefined, // channelHealthFor
    false, // priceRequiresLiveChannelEnabled
    false, // proactiveOpenerEnabled
    undefined, // refreshFacts
    true, // autonomousMoneyPitchesEnabled — the flag under test
  );
  return brain;
}

const RELATIONSHIPS: (Relationship | undefined)[] = [
  undefined,
  "anonymous",
  "new",
  "repeat",
  "vip",
  "subscriber",
  "replenishment_due",
  "lapsed",
  "one_and_done",
];
const CARTS: ("empty" | "has_items" | "high_value" | undefined)[] = [
  undefined,
  "empty",
  "has_items",
  "high_value",
];
const LEVELS: ProactivityLevel[] = ["cautious", "balanced", "confident"];
// Two messages exercise BOTH selectPitch branches: a plain discovery turn (isObjection=false) and a
// price objection (isObjection=true → objection_close, which must also never be a money pitch).
const MESSAGES = [
  "what should I get for dull skin?",
  "honestly $45 is too expensive — send me a code or I'm going elsewhere",
];

describe("structural: the reactive selector never emits a money-gated pitch (NN#1)", () => {
  it("MONEY_GATED_PITCHES is exactly the three money-moving kinds", () => {
    expect([...MONEY_GATED_PITCHES].sort()).toEqual(["promo", "subscription", "upsell"]);
  });

  it("d.pitch is NEVER upsell/subscription/promo across every relationship × cart × level × objection", async () => {
    const brain = spyBrain();
    const violations: string[] = [];
    for (const relationship of RELATIONSHIPS) {
      for (const cart of CARTS) {
        for (const proactivityLevel of LEVELS) {
          for (const message of MESSAGES) {
            const d = await brain.decide(
              { relationship: relationship as never, cart, proactivityLevel, mood: "neutral" },
              message,
            );
            if ((MONEY_GATED_PITCHES as readonly string[]).includes(d.pitch)) {
              violations.push(`rel=${relationship} cart=${cart} lvl=${proactivityLevel} → ${d.pitch}`);
            }
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

// WS-C — flag ON. `promo` must STILL never be reachable (Owner authorized upsell + subscription only —
// no branch anywhere returns "promo", flag state notwithstanding), while upsell/subscription become
// reachable through the two specific, narrow triggers in selectPitch (brain.ts): a confident shopper with
// items in cart yields the trade-up "upsell" instead of "cross_sell", and a confident shopper who is due
// for replenishment (not "lapsed") yields "subscription" instead of "replenishment".
describe("structural: with AUTONOMOUS_MONEY_PITCHES on, promo stays unreachable and upsell/subscription become reachable", () => {
  it("d.pitch is NEVER promo across every relationship × cart × level × objection, even flag-on", async () => {
    const brain = spyBrainMoneyPitchesOn();
    const violations: string[] = [];
    for (const relationship of RELATIONSHIPS) {
      for (const cart of CARTS) {
        for (const proactivityLevel of LEVELS) {
          for (const message of MESSAGES) {
            const d = await brain.decide(
              { relationship: relationship as never, cart, proactivityLevel, mood: "neutral" },
              message,
            );
            if (d.pitch === "promo") {
              violations.push(`rel=${relationship} cart=${cart} lvl=${proactivityLevel} → ${d.pitch}`);
            }
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("a confident shopper with items in cart reaches upsell", async () => {
    const brain = spyBrainMoneyPitchesOn();
    const d = await brain.decide(
      { relationship: "repeat", cart: "has_items", proactivityLevel: "confident", mood: "neutral" },
      "what should I get for dull skin?",
    );
    expect(d.pitch).toBe("upsell");
  });

  it("a confident shopper due for replenishment reaches subscription", async () => {
    const brain = spyBrainMoneyPitchesOn();
    const d = await brain.decide(
      { relationship: "replenishment_due", cart: "empty", proactivityLevel: "confident", mood: "neutral" },
      "what should I get for dull skin?",
    );
    expect(d.pitch).toBe("subscription");
  });

  it("a lapsed (not replenishment_due) shopper still reaches the ordinary replenishment pitch, flag-on", async () => {
    const brain = spyBrainMoneyPitchesOn();
    const d = await brain.decide(
      { relationship: "lapsed", cart: "empty", proactivityLevel: "confident", mood: "neutral" },
      "what should I get for dull skin?",
    );
    expect(d.pitch).toBe("replenishment");
  });

  it("a balanced shopper with items in cart still reaches the ordinary cross_sell pitch, flag-on", async () => {
    const brain = spyBrainMoneyPitchesOn();
    const d = await brain.decide(
      { relationship: "repeat", cart: "has_items", proactivityLevel: "balanced", mood: "neutral" },
      "what should I get for dull skin?",
    );
    expect(d.pitch).toBe("cross_sell");
  });
});
