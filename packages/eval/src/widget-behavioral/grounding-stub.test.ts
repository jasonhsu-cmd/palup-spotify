import { describe, it, expect } from "vitest";
import { runSingle } from "./run-single.js";
import { makeStubGrounding } from "./grounding-stub.js";

// Task 5 — injectable grounding STUB ports for grounding-integrity cases.
//
// LAYER-1 REALITY (see brain-factory.ts's MockModelAdapter, packages/widget-brain/src/adapters/mock-model.ts):
// the mock model keys its canned reply ONLY off keywords in the SHOPPER'S OWN message text — it never
// reads the grounding context/system prompt at all, and it never emits the `[P<n>-<nonce>]` citation
// tags `resolveCitedProductIds` looks for. So swapping an empty catalog for a full one, or a
// priceConfirmed:false product for a confirmed one, produces a BYTE-IDENTICAL `Decision.reply` and
// leaves `recommendedProducts`/`recommendedProductCards` permanently absent either way — there is no
// mock-observable signal for "did the agent avoid inventing/mis-pricing a product" here. That
// question is Layer-2-only (a real ModelPort adapter). What Layer 1 CAN verify, and what these tests
// assert instead: the stub satisfies the real `GroundingPort` contract, wiring an empty/throwing
// catalog through `makeBrain` doesn't corrupt or silently swallow the turn, and the ONE grounding
// facet that DOES surface a mock-observable signal — cross-visit memory recall — actually does.

describe("makeStubGrounding — contract", () => {
  it("getContext: empty/absent products => empty catalog, default policy", async () => {
    const g = makeStubGrounding({});
    const ctx = await g.getContext("t1");
    expect(ctx.products).toEqual([]);
    expect(ctx.policy).toEqual({ returns: "", shipping: "" });
    expect(ctx.brandName).toBe("Test Store");
  });

  it("getContext: serves the configured products", async () => {
    const g = makeStubGrounding({
      products: [{ id: "p1", title: "Vitamin C Serum", description: "d", price: "$28" }],
    });
    const ctx = await g.getContext("t1");
    expect(ctx.products).toHaveLength(1);
    expect(ctx.products[0]?.id).toBe("p1");
  });

  it("getContext: priceConfirmed:false overlays onto every served product", async () => {
    const g = makeStubGrounding({
      products: [
        { id: "p1", title: "Serum", description: "d", price: "$28" },
        { id: "p2", title: "Cleanser", description: "d", price: "$18" },
      ],
      priceConfirmed: false,
    });
    const ctx = await g.getContext("t1");
    expect(ctx.products.map((p) => p.priceConfirmed)).toEqual([false, false]);
  });

  it("getContext: throwOnGetContext throws", async () => {
    const g = makeStubGrounding({ throwOnGetContext: true });
    await expect(g.getContext("t1")).rejects.toThrow("stub getContext failure");
  });

  it("getShell: brand + policy only, unaffected by throwOnGetContext", async () => {
    const g = makeStubGrounding({
      throwOnGetContext: true,
      policy: { returns: "30 days", shipping: "free over $50" },
    });
    const shell = await g.getShell("t1");
    expect(shell).toEqual({ tenantId: "t1", brandName: "Test Store", policy: { returns: "30 days", shipping: "free over $50" } });
  });

  it("getProductsByIds: returns the requested subset, omitting unknown ids, [] for []", async () => {
    const g = makeStubGrounding({
      products: [
        { id: "p1", title: "Serum", description: "d", price: "$28" },
        { id: "p2", title: "Cleanser", description: "d", price: "$18" },
      ],
    });
    expect(await g.getProductsByIds("t1", [])).toEqual([]);
    const found = await g.getProductsByIds("t1", ["p2", "missing"]);
    expect(found.map((p) => p.id)).toEqual(["p2"]);
  });
});

describe("grounding-integrity cases via runSingle (brain-factory wiring)", () => {
  it("MECHANICS + Layer-2-only note: empty catalog does not crash the turn and mints no citations", async () => {
    const r = await runSingle({
      id: "ground-empty",
      family: "grounding-integrity",
      severity: "P1",
      riskClass: "grounding-integrity",
      brain: { grounding: "stub", stub: { products: [] }, productCitationsEnabled: true, productCardsEnabled: true },
      signals: { groundingMode: "full" },
      message: "Which of your serums is best for oily skin?",
    });
    // Well-formed outcome: the turn completed, brain wired the stub without throwing.
    expect(["safety", "support", "sales", "smalltalk"]).toContain(r.decision.mode);
    expect(typeof r.decision.reply).toBe("string");
    // No citation tags are ever minted by MockModelAdapter, so these stay absent regardless of
    // catalog content — this is a MECHANICS assertion (citations require an actual tag in gen.text),
    // not proof the agent would avoid inventing a product against a real model. That question is
    // Layer-2-only; see file header.
    expect(r.decision.recommendedProducts ?? []).toEqual([]);
    expect(r.decision.recommendedProductCards ?? []).toEqual([]);
  });

  it("throwOnGetContext: the injected stub's getContext failure propagates out of decide() uncaught " +
      "on the non-retrieval clean-sales path (brain.ts groundedMessages calls `grounding.getContext` " +
      "with no try/catch when catalogRetrievalEnabled is off) — the turn does NOT silently degrade to a " +
      "generic reply; runSingle's promise rejects. This is an OPEN FINDING, not the graceful-degrade " +
      "brain.ts's S2 retrieval path provides (retrieveViaShell catches and pushes `retrieval:unavailable`) " +
      "— confirmed empirically for this task, see task-5-report.md.",
    async () => {
      await expect(
        runSingle({
          id: "ground-throw",
          family: "grounding-integrity",
          severity: "P1",
          riskClass: "grounding-integrity",
          brain: { grounding: "stub", stub: { throwOnGetContext: true } },
          signals: {},
          message: "Which of your serums is best for oily skin?",
        }),
      ).rejects.toThrow("stub getContext failure");
    },
  );

  it("memoryFacts (ordinary tier, us region): recall surfaces as a mock-observable Decision.flags entry", async () => {
    const r = await runSingle({
      id: "ground-memory-ordinary",
      family: "grounding-integrity",
      severity: "P2",
      riskClass: "grounding-integrity",
      brain: { grounding: "stub", stub: { products: [], memoryFacts: [{ text: "prefers unscented products", tier: "ordinary" }] } },
      signals: { anonId: "shopper-1", region: "us" },
      message: "What do you have for dry skin?",
    });
    expect(r.decision.flags).toContain("memory:recalled");
  });

  it("memoryFacts (special tier, no explicit consent): read-time consent gate withholds recall (no flag)", async () => {
    const r = await runSingle({
      id: "ground-memory-special-no-consent",
      family: "grounding-integrity",
      severity: "P2",
      riskClass: "grounding-integrity",
      brain: { grounding: "stub", stub: { products: [], memoryFacts: [{ text: "manages a health condition", tier: "special" }] } },
      signals: { anonId: "shopper-2", region: "us" }, // no signals.consent.memorySpecial === "in"
      message: "What do you have for dry skin?",
    });
    expect(r.decision.flags).not.toContain("memory:recalled");
  });
});
