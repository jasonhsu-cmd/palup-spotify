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
