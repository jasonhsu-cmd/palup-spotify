import { describe, it, expect, vi } from "vitest";
import { createBrain, DEFAULT_POLICY, StaticGroundingAdapter, MockCommerceAdapter } from "../src/index.js";
import type { ModelPort, Signals } from "../src/index.js";
import type { CatalogRetrieverPort } from "../src/types.js";

function fakeModel(): ModelPort {
  return { async complete() { return { text: "sure", model: "fake" }; }, async embed() { throw new Error("unused"); } };
}
function brainWith(retrieve: ReturnType<typeof vi.fn>) {
  const grounding = new StaticGroundingAdapter();
  const retriever = { retrieve } as unknown as CatalogRetrieverPort;
  return createBrain(fakeModel(), grounding, DEFAULT_POLICY, new MockCommerceAdapter(), "shopper-demo",
    undefined, false, false, false, false, retriever, false, 5);
}

describe("brain — retrieval-scoped kill degrades to full-catalog, never halts", () => {
  it("enabled + killed ⇒ getContext path, retrieval:killed flagged, retriever NOT consulted, NO turn halt", async () => {
    const retrieve = vi.fn(async () => { throw new Error("must not be called when killed"); });
    const signals: Signals = { tenantId: "demo", catalogRetrievalEnabled: true, catalogRetrievalKilled: true };
    const d = await brainWith(retrieve).decide(signals, "show me a warm winter jacket");
    expect(retrieve).not.toHaveBeenCalled();
    expect(d.flags).toContain("retrieval:killed");
    expect(d.flags).not.toContain("kill_switch"); // NOT the shopper turn-halt
    expect(d.flags).not.toContain("no_autonomous_action");
    expect(d.mode).not.toBe("support"); // a normal sales turn, just full-catalog
  });

  it("enabled + not killed ⇒ retrieval still runs (no false degrade)", async () => {
    const retrieve = vi.fn(async () => ({ hits: [{ productId: "p1", score: 1, metadata: { title: "Warm Jacket" } }], corpusProductCount: 3 }));
    const d = await brainWith(retrieve).decide({ tenantId: "demo", catalogRetrievalEnabled: true }, "show me a jacket");
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(d.flags).not.toContain("retrieval:killed");
  });

  it("the SHOPPER turn-halt kill still halts the whole turn (unchanged)", async () => {
    const retrieve = vi.fn(async () => ({ ctx: undefined, rendered: [], corpusTotal: 0 }));
    const d = await brainWith(retrieve).decide({ tenantId: "demo", kill: true, catalogRetrievalEnabled: true }, "hi");
    expect(d.flags).toContain("kill_switch");
    expect(d.escalateToHuman).toBe(true);
  });
});
