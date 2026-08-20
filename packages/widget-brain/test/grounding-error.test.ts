import { describe, it, expect, vi } from "vitest";
import type { ModelPort, ModelRequest } from "@palup/platform-ports";
import type { GroundingContext, GroundingPort, GroundingShell, Product } from "@palup/platform-ports";
import { createBrain } from "../src/index.js";

// F2 — the brain's clean sales path calls `grounding.getContext` with no local try/catch, so a raw
// (uncached) adapter's throw used to propagate straight out of `decide()`. In production this is
// mitigated by createCachingGroundingPort (it already catches getContext failures and fails closed),
// but the raw throw is reachable whenever a grounding adapter is used WITHOUT that wrapper. This test
// pins the fix: decide() must never throw, and the degrade must be OBSERVABLE (a distinct flag), never
// a silent empty-catalog fallback that could read as a confident "we don't carry that".
class ThrowingGrounding implements GroundingPort {
  async getContext(_tenantId: string): Promise<GroundingContext> {
    throw new Error("grounding backend unavailable");
  }
  async getShell(tenantId: string): Promise<GroundingShell> {
    return { tenantId, brandName: "Test Store", policy: { returns: "", shipping: "" } };
  }
  async getProductsByIds(_tenantId: string, _ids: string[]): Promise<Product[]> {
    return [];
  }
}

describe("F2 — brain-level getContext degrade", () => {
  it("decide() does not throw when getContext rejects, and records grounding:unavailable (not a silent empty catalog)", async () => {
    const spy = vi.fn<ModelPort["complete"]>(async () => ({ text: "sure, let me help", model: "spy" }));
    const spyPort: ModelPort = { complete: spy };
    const brain = createBrain(spyPort, new ThrowingGrounding());

    const decision = await brain.decide({ mood: "neutral", cart: "has_items" }, "do you carry vitamin C serum?");

    expect(decision.reply).toBe("sure, let me help");
    expect(decision.flags).toContain("grounding:unavailable");

    // The prompt sent to the model must NOT assert an empty catalog (which would license a confident
    // "we don't carry that") — it must fall back to the plain generic-assistant prompt (systemPrompt's
    // `if (!ctx) return [...]` branch, a string unique to the no-context path) rather than one built
    // from a synthesized empty product list, so the model's existing "say you're not certain and will
    // check" rule governs the reply instead of a confident denial.
    const req = spy.mock.calls[0]![0] as ModelRequest;
    const system = req.messages.find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain("You are an online store's shopping assistant.");
    expect(system).toContain("say you're not certain");
  });
});
