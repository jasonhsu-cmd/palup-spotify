import { describe, it, expect, vi } from "vitest";
import type { ModelPort } from "@palup/platform-ports";
import { createBrain, DEFAULT_POLICY, StaticGroundingAdapter, MockCommerceAdapter } from "../src/index.js";
import type { Signals } from "../src/index.js";
import type { CatalogRetrieverPort } from "../src/types.js";

function fakeModel(): ModelPort {
  return { async complete() { return { text: "sure", model: "fake" }; }, async embed() { throw new Error("unused"); } };
}

describe("brain — CATALOG_RETRIEVAL is a per-turn signal, not a baked-in flag", () => {
  it("consults the retriever when signals.catalogRetrievalEnabled is true even with the constructor flag OFF", async () => {
    const grounding = new StaticGroundingAdapter();
    const retrieve = vi.fn(async () => ({ hits: [{ productId: "p1", score: 1, metadata: { title: "Warm Jacket" } }], corpusProductCount: 3 }));
    const retriever = { retrieve } as unknown as CatalogRetrieverPort;
    // Positions 11 (retriever), 12 (catalogRetrievalEnabled=false — the new prod default), 13 (k).
    const brain = createBrain(fakeModel(), grounding, DEFAULT_POLICY, new MockCommerceAdapter(), "shopper-demo",
      undefined, false, false, false, false, retriever, false, 5);
    const signals: Signals = { tenantId: "demo", catalogRetrievalEnabled: true };
    const d = await brain.decide(signals, "show me a warm winter jacket");
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(d.flags).toContain("retrieval:applied");
  });

  it("does NOT consult the retriever when the per-turn signal is absent (full-catalog path)", async () => {
    const grounding = new StaticGroundingAdapter();
    const retrieve = vi.fn(async () => ({ hits: [{ productId: "p1", score: 1, metadata: { title: "Warm Jacket" } }], corpusProductCount: 3 }));
    const retriever = { retrieve } as unknown as CatalogRetrieverPort;
    const brain = createBrain(fakeModel(), grounding, DEFAULT_POLICY, new MockCommerceAdapter(), "shopper-demo",
      undefined, false, false, false, false, retriever, false, 5);
    const d = await brain.decide({ tenantId: "demo" }, "show me a warm winter jacket");
    expect(retrieve).not.toHaveBeenCalled();
    expect(d.flags).not.toContain("retrieval:applied");
  });
});
