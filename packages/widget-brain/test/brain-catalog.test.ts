import { describe, it, expect } from "vitest";
import type { ModelPort, ModelRequest, ModelResponse } from "@palup/platform-ports";
import { createBrain, MockModelAdapter, StaticGroundingAdapter, MockCommerceAdapter, DEFAULT_POLICY } from "../src/index.js";

// D2 (conversation-quality wave 1): the model must SEE each product's ingredient list in the catalog so
// it can name the real actives (skeptic/evidence questions) and answer "does it contain X?" grounded in
// the list — instead of marketing adjectives. Captures the system prompt the brain sends to the model.

class CapturingModel implements ModelPort {
  system = "";
  private inner = new MockModelAdapter();
  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.system = req.messages.find((m) => m.role === "system")?.content ?? "";
    return this.inner.complete(req);
  }
}

describe("catalog block grounds ingredients (D2)", () => {
  it("a product question reaches the model with the product's real actives in the catalog", async () => {
    const model = new CapturingModel();
    const brain = createBrain(model, new StaticGroundingAdapter(), DEFAULT_POLICY, new MockCommerceAdapter(), "shopper-demo");
    await brain.decide({} as never, "tell me about your vitamin c serum");
    // The Vitamin-C Brightening Serum fixture lists Ascorbic Acid + Ferulic Acid — both must be visible.
    expect(model.system).toContain("Ingredients:");
    expect(model.system).toContain("Ascorbic Acid");
    expect(model.system).toContain("Ferulic Acid");
  });

  it("a product with NO published ingredient list adds no Ingredients: segment (optional field)", async () => {
    const model = new CapturingModel();
    const brain = createBrain(model, new StaticGroundingAdapter(), DEFAULT_POLICY, new MockCommerceAdapter(), "shopper-demo");
    await brain.decide({} as never, "what sets do you sell?");
    // The bundle fixtures (Starter/Glow Set) carry no ingredients array — the line must not print a bare "Ingredients:".
    expect(model.system).not.toContain("Ingredients: .");
    expect(model.system).not.toMatch(/Ingredients:\s*\n/);
  });
});
