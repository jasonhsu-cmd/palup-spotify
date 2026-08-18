import { describe, it, expect, vi } from "vitest";
import type { ModelPort } from "@palup/platform-ports";
import { createBrain, DEFAULT_POLICY, StaticGroundingAdapter, MockCommerceAdapter, MONEY_GATED_PITCHES } from "../src/index.js";
import type { Relationship, ProactivityLevel } from "../src/index.js";

// WS6 — STRUCTURAL money boundary for the greeting, mirroring select-pitch-money-boundary.test.ts. The
// first-touch greeting is agent-initiated and reaches shoppers, so it is exactly the kind of surface a
// self-improving agent could be tempted to turn into a pitch. This makes it a CI-enforced invariant that a
// greeting NEVER emits any pitch (let alone a money-gated one) and never spends the pitch budget — no future
// edit to the greeting rung can cross the money boundary (§3 / NN#1) unnoticed.

function greetingBrain(model: ModelPort) {
  return createBrain(
    model, new StaticGroundingAdapter(), DEFAULT_POLICY, new MockCommerceAdapter(), "shopper-demo",
    undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    true, // greetingProactiveEnabled
  );
}

const RELATIONSHIPS: (Relationship | undefined)[] = [
  undefined, "anonymous", "new", "repeat", "vip", "subscriber", "replenishment_due", "lapsed", "one_and_done",
];
const CARTS: ("empty" | "has_items" | "high_value" | undefined)[] = [undefined, "empty", "has_items", "high_value"];
const LEVELS: ProactivityLevel[] = ["cautious", "balanced", "confident"];
const MOODS = [undefined, "neutral", "frustrated", "upset", "anxious", "satisfied"] as const;

describe("WS6 — the greeting never emits a money-gated pitch (NN#1)", () => {
  it("across relationship × cart × level × mood, a greeting yields pitch:'none' — never money-gated, never outbound", async () => {
    const spy = vi.fn<ModelPort["complete"]>(async () => ({ text: "Welcome — happy to help you find something today.", model: "spy" }));
    const brain = greetingBrain({ complete: spy });
    for (const relationship of RELATIONSHIPS) {
      for (const cart of CARTS) {
        for (const level of LEVELS) {
          for (const mood of MOODS) {
            const label = `${relationship}/${cart}/${level}/${mood}`;
            const d = await brain.decide(
              { tenantId: "demo", relationship, cart, proactivityLevel: level, mood, proactiveTrigger: "greeting" } as never,
              "",
            );
            expect(d.pitch, label).toBe("none");
            expect(MONEY_GATED_PITCHES as readonly string[], label).not.toContain(d.pitch);
            expect(d.outbound, label).toBe(false);
          }
        }
      }
    }
  });
});
