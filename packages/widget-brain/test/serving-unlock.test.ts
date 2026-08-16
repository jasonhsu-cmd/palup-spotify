import { describe, it, expect } from "vitest";
import type { GroundingPort, ModelPort, ProductFactsPort } from "@palup/platform-ports";
import { createInMemoryProductFactsStore } from "@palup/platform-ports";
import { createBrain, DEFAULT_POLICY } from "../src/index.js";
import type { CatalogRetrieverPort, Signals } from "../src/types.js";

/** A grounding port whose getContext THROWS (proving the render path never calls it) but whose getShell
 *  returns brand+policy. */
function shellOnlyGrounding(): GroundingPort {
  return {
    async getContext() {
      throw new Error("getContext must not be called on the retrieval render path");
    },
    async getShell(tenantId) {
      return { tenantId, brandName: "BigStore", policy: { returns: "30 days", shipping: "free" } };
    },
  };
}

/** A retriever returning two hits WITH render metadata + a corpus size of 1500. */
function fakeRetriever(): CatalogRetrieverPort {
  return {
    async retrieve() {
      return {
        corpusProductCount: 1500,
        hits: [
          { productId: "p-serum", score: 0.9, metadata: { kind: "product", productId: "p-serum", title: "Glow Serum", variantId: "v1" } },
          { productId: "p-cream", score: 0.8, metadata: { kind: "product", productId: "p-cream", title: "Night Cream" } },
        ],
      };
    },
  };
}

/** Captures the system prompt so we can assert what was rendered. */
function capturingModel(): { model: ModelPort; system: () => string } {
  let sys = "";
  return {
    system: () => sys,
    model: {
      async complete(req) {
        sys = req.messages.find((m) => m.role === "system")?.content ?? "";
        return { text: "Here are two options.", model: "mock" };
      },
      async embed() {
        throw new Error("brain does not embed");
      },
    },
  };
}

const K = 12;
const signals: Signals = { tenantId: "t1" };

describe("S2 — serving unlock render path", () => {
  it("renders top-K products built from corpus metadata + fresh ProductFacts price, no getContext", async () => {
    const facts = createInMemoryProductFactsStore();
    await facts.upsertMany("t1", [
      { productId: "p-serum", price: "$40", availableForSale: true, updatedAt: new Date().toISOString() },
      { productId: "p-cream", price: "$55", updatedAt: new Date().toISOString() },
    ]);
    const { model, system } = capturingModel();
    const brain = createBrain(
      model, shellOnlyGrounding(), DEFAULT_POLICY, undefined, "shopper-demo",
      undefined, false, false, false, false,
      fakeRetriever(),   // catalogRetriever
      true,              // catalogRetrievalEnabled
      K,                 // catalogRetrievalK
      false, false, false, false, // citations/cards/cart/serverGuard
      facts as ProductFactsPort, // productFactsPort
      true,              // productFactsHydrationEnabled
    );
    const decision = await brain.decide(signals, "I want a serum");
    const prompt = system();
    expect(decision.flags).toContain("retrieval:applied");
    expect(prompt).toContain("Glow Serum ($40)");
    expect(prompt).toContain("Night Cream ($55)");
    // "N of M" reads the corpus count from the manifest, not ctx.products.
    expect(prompt).toContain("CATALOG (2 of 1500 products");
  });

  it("fails OPEN with no catalog block when retrieval throws (no full catalog to fall back to)", async () => {
    const throwingRetriever: CatalogRetrieverPort = {
      async retrieve() {
        throw new Error("corpus unavailable");
      },
    };
    const { model, system } = capturingModel();
    const brain = createBrain(
      model, shellOnlyGrounding(), DEFAULT_POLICY, undefined, "shopper-demo",
      undefined, false, false, false, false,
      throwingRetriever, true, K,
    );
    const decision = await brain.decide(signals, "I want a serum");
    expect(decision.flags).toContain("retrieval:unavailable");
    // Brand + policy still present; no product lines.
    expect(system()).toContain("BigStore");
    expect(system()).not.toContain("Glow Serum");
  });
});
