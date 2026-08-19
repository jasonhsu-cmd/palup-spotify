import { describe, it, expect } from "vitest";
import {
  createBrain,
  MockModelAdapter,
  StaticGroundingAdapter,
  MockCommerceAdapter,
  DEFAULT_POLICY,
} from "../src/index.js";
import type { GroundingPort } from "@palup/platform-ports";

// Pillar 3b — the opener's best-fit product CARD. Chosen DETERMINISTICALLY from the ALREADY-CACHED grounding
// context (zero extra inference, no LLM citation) so it can never fabricate a product/price — the card is a
// real catalog entry. Gated on PRODUCT_CARDS. Fail-open: no catalog ⇒ no card, greeting + chips still land.

// createBrain positional tail: … productCards(15) … greetingProactiveEnabled(24) … proactiveOpenerEnabled(27).
function openerCardBrain(opts: { cards?: boolean; grounding?: GroundingPort } = {}) {
  return createBrain(
    new MockModelAdapter(), opts.grounding ?? new StaticGroundingAdapter(), DEFAULT_POLICY, new MockCommerceAdapter(), "shopper-demo",
    undefined, undefined, undefined, undefined, undefined, // 6-10: memory, subscription, disposition×3
    undefined, undefined, undefined, undefined, opts.cards ?? true, undefined, // 11-16: retriever, retrievalEnabled, K, citations, CARDS(15), cartLineItems
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, // 17-23
    true, // 24 greetingProactiveEnabled
    undefined, undefined, // 25 channelHealthFor, 26 priceRequiresLiveChannelEnabled
    true, // 27 proactiveOpenerEnabled
  );
}
const OPEN = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  tenantId: "demo",
  proactiveTrigger: "greeting",
  mood: "neutral",
  ...extra,
});

describe("Pillar 3b — opener best-fit product card (the VIEWED product, from the cached catalog)", () => {
  const ON_PDP = { pageContext: "product:cleanser-gentle" }; // shopper is viewing this product

  it("on a PDP: mints ONE card for the VIEWED product + the chips, still pitch:none, from a REAL catalog entry", async () => {
    const brain = openerCardBrain({ cards: true });
    const d = await brain.decide(OPEN(ON_PDP) as never, "");
    expect(d.pitch).toBe("none");
    expect(d.flags).toContain("opener");
    expect(d.flags).toContain("opener:card");
    expect(d.suggestedChips).toHaveLength(3);
    expect(d.recommendedProducts).toEqual(["cleanser-gentle"]); // the product the shopper is viewing
    expect(d.recommendedProductCards).toHaveLength(1);
    const card = d.recommendedProductCards![0];
    expect(card.productId).toBe("cleanser-gentle");
    expect(card.title).toBe("Gentle Daily Cleanser"); // a real merchant title — never fabricated
    expect(card.price).toBe("$18");
  });

  it("OFF a product page: NO card (no arbitrary pick) — the greeting + chips still carry the opener", async () => {
    const brain = openerCardBrain({ cards: true });
    const d = await brain.decide(OPEN() as never, ""); // no pageContext → not on a PDP
    expect(d.flags).toContain("opener");
    expect(d.flags).not.toContain("opener:card");
    expect(d).not.toHaveProperty("recommendedProductCards");
    expect(d.suggestedChips).toHaveLength(3);
  });

  it("a pageContext product that isn't in the catalog: NO card (never fabricates a match)", async () => {
    const brain = openerCardBrain({ cards: true });
    const d = await brain.decide(OPEN({ pageContext: "product:not-a-real-handle" }) as never, "");
    expect(d.flags).toContain("opener");
    expect(d).not.toHaveProperty("recommendedProductCards");
    expect(d.suggestedChips).toHaveLength(3);
  });

  it("no card when PRODUCT_CARDS is off, even on a PDP — the greeting + chips still land", async () => {
    const brain = openerCardBrain({ cards: false });
    const d = await brain.decide(OPEN(ON_PDP) as never, "");
    expect(d.flags).toContain("opener");
    expect(d.flags).not.toContain("opener:card");
    expect(d).not.toHaveProperty("recommendedProductCards");
    expect(d).not.toHaveProperty("recommendedProducts");
    expect(d.suggestedChips).toHaveLength(3);
  });

  it("no card (fail-open) when the catalog is empty — greeting + chips still land", async () => {
    const emptyGrounding = {
      getContext: async () => ({ tenantId: "demo", brandName: "x", products: [], policy: { returns: "", shipping: "" } }),
      getShell: async () => ({ tenantId: "demo", brandName: "x", policy: { returns: "", shipping: "" } }),
      getProductsByIds: async () => [],
    } as unknown as GroundingPort;
    const brain = openerCardBrain({ cards: true, grounding: emptyGrounding });
    const d = await brain.decide(OPEN(ON_PDP) as never, ""); // on a PDP, but the catalog came back empty
    expect(d.flags).toContain("opener");
    expect(d).not.toHaveProperty("recommendedProductCards");
    expect(d.suggestedChips).toHaveLength(3);
  });
});
