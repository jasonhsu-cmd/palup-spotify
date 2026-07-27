import { describe, it, expect, vi } from "vitest";
import { runGroundingPortContract } from "@palup/platform-ports/contract/grounding";
import type { ModelPort, ModelRequest } from "@palup/platform-ports";
import { createBrain, StaticGroundingAdapter } from "../src/index.js";

// The static demo adapter satisfies the grounding port contract (ADR-0001).
runGroundingPortContract(() => new StaticGroundingAdapter());

describe("brain grounding injection", () => {
  it("passes brand, catalog, and guardrail rules to the model as a system message", async () => {
    const spy = vi.fn<ModelPort["complete"]>(async () => ({ text: "sure", model: "spy" }));
    const spyPort: ModelPort = { complete: spy };
    const brain = createBrain(spyPort, new StaticGroundingAdapter());

    await brain.decide({ mood: "neutral", cart: "has_items" }, "something for dark circles?");

    const req = spy.mock.calls[0]![0] as ModelRequest;
    const system = req.messages.find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain("Auria"); // brand
    expect(system).toContain("Caffeine Eye Cream"); // a real catalog product
    expect(system).toContain("never invent products, prices, or discounts");
    expect(system).toContain("Never make medical or disease claims");
  });
});
