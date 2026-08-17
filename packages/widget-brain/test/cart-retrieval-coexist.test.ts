import { describe, it, expect } from "vitest";
import type { GroundingPort, ModelPort, Product } from "@palup/platform-ports";
import { createCachingGroundingPort, InMemoryRuntimeStore } from "@palup/platform-ports";
import { createBrain } from "../src/index.js";
import type { CatalogRetrieverPort, Signals } from "../src/types.js";

// CART_LINE_ITEMS x CATALOG_RETRIEVAL coexistence.
//
// THE BUG THESE TESTS PIN: on the retrieval RENDER path (S2), the brain fetches only a brand/policy
// SHELL and builds `ctx` with `products: []` (brain.ts's `retrieveViaShell`). `renderCartBlock` resolves
// every cart line item ONLY against `ctx.products` — so with `products: []`, EVERY cart item silently
// drops and the cart block never renders, even though the shopper's cart is genuinely non-empty and the
// flag is on. Cart ids are arbitrary client input (not the retrieved top-K), so there is no way to
// recover a title/price for them from the retrieval hits either.
//
// THE FIX (not implemented here — tests only): a NEW required `GroundingPort.getProductsByIds(tenantId,
// ids)` method, called with ONLY the cart's own ids (never the top-K, never the full catalog) whenever
// `ctx` exists AND `cartLineItemsEnabled` AND the cart is non-empty. On failure it fails CLOSED: no cart
// block, and a `cart:byid_unavailable` flag records the degrade (today's parked behavior, made
// observable instead of silent).

/** A GroundingPort mock extended with the not-yet-real `getProductsByIds`, so this file type-checks
 *  against today's port (which does not declare the method) while still exercising the exact call
 *  shape the real adapters will implement. */
type GroundingPortWithByIds = GroundingPort & {
  getProductsByIds(tenantId: string, ids: string[]): Promise<Product[]>;
};

/** A grounding port whose `getContext` THROWS (proving the render path never pages the full catalog),
 *  mirroring `serving-unlock.test.ts`'s `shellOnlyGrounding`, extended with a caller-supplied
 *  `getProductsByIds`. */
function shellOnlyGroundingWithByIds(
  byIds: (tenantId: string, ids: string[]) => Promise<Product[]>,
): GroundingPortWithByIds {
  return {
    async getContext() {
      throw new Error("getContext must not be called on the retrieval render path");
    },
    async getShell(tenantId) {
      return { tenantId, brandName: "BigStore", policy: { returns: "30 days", shipping: "free" } };
    },
    getProductsByIds: byIds,
  };
}

/** A retriever returning a fixed set of top-K hits, deliberately DISJOINT from any cart id used below —
 *  so a cart line resolving correctly can only be explained by the by-id fetch, never by retrieval. */
function fakeRetriever(hits: Array<{ productId: string; title: string }> = [{ productId: "p-cream", title: "Night Cream" }], corpusProductCount = 500): CatalogRetrieverPort {
  return {
    async retrieve() {
      return {
        corpusProductCount,
        hits: hits.map((h, i) => ({ productId: h.productId, score: 1 - i / 100, metadata: { kind: "product", productId: h.productId, title: h.title } })),
      };
    },
  };
}

/** Captures the last system prompt, mirroring `serving-unlock.test.ts`'s `capturingModel`. */
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

const ASK = "does this go with what I already have?";

describe("CART_LINE_ITEMS x CATALOG_RETRIEVAL coexistence", () => {
  it("retrieval ON + cart ON: line items resolve via getProductsByIds and render in the cart fence", async () => {
    const { model, system } = capturingModel();
    const grounding = shellOnlyGroundingWithByIds(async (_tenantId, ids) =>
      ids
        .filter((id) => id === "p-serum")
        .map((id) => ({ id, title: "Glow Serum", price: "$40", description: "" })),
    );
    const brain = createBrain(
      model, grounding, undefined, undefined, undefined, undefined,
      false, false, false, false,
      fakeRetriever(), // catalogRetriever — returns a DIFFERENT product (p-cream), never p-serum
      true,            // catalogRetrievalEnabled
      12,              // catalogRetrievalK
      false, false, true, false, // citations/cards OFF, cartLineItemsEnabled ON, serverGuard OFF
    );
    const signals: Signals = { tenantId: "t1", cart: "has_items", cartItems: [{ productId: "p-serum", quantity: 1 }] };
    const decision = await brain.decide(signals, ASK);
    const sys = system();
    expect(sys).toContain("=== SHOPPER CART");
    expect(sys).toContain("- 1 x Glow Serum ($40)");
    expect(decision.flags).toContain("cart:items");
  });

  it("the by-id fetch receives ONLY the cart's ids, never the top-K/full catalog", async () => {
    const { model } = capturingModel();
    let receivedTenant: string | undefined;
    let receivedIds: string[] | undefined;
    const grounding = shellOnlyGroundingWithByIds(async (tenantId, ids) => {
      receivedTenant = tenantId;
      receivedIds = ids;
      return ids.map((id) => ({ id, title: `Title for ${id}`, price: "$1", description: "" }));
    });
    // A top-K of 8 DIFFERENT ids from the cart's 3, so the fetch can be shown to receive exactly (and
    // only) the cart's own ids.
    const retriever = fakeRetriever(
      Array.from({ length: 8 }, (_, i) => ({ productId: `top-${i}`, title: `Top ${i}` })),
      5000,
    );
    const cartItems = [
      { productId: "p-1", quantity: 1 },
      { productId: "p-2", quantity: 2 },
      { productId: "p-3", quantity: 1 },
    ];
    const brain = createBrain(
      model, grounding, undefined, undefined, undefined, undefined,
      false, false, false, false,
      retriever, true, 12,
      false, false, true, false,
    );
    const signals: Signals = { tenantId: "t9", cart: "has_items", cartItems };
    await brain.decide(signals, "anything for my cart?");
    expect(receivedTenant).toBe("t9");
    expect(receivedIds).toEqual(cartItems.map((i) => i.productId));
    // MAX_CART_LINE_ITEMS = 30 (packages/widget-backend/src/signals.ts:45) — the cart is server-bounded
    // to that ceiling before it ever reaches the brain, so the by-id fetch can never be handed more ids.
    expect(receivedIds!.length).toBeLessThanOrEqual(30);
    expect(receivedIds).not.toEqual(expect.arrayContaining(["top-0"]));
  });

  it("getProductsByIds throwing degrades to no cart block (parked behavior), reply still produced", async () => {
    const { model, system } = capturingModel();
    const grounding = shellOnlyGroundingWithByIds(async () => {
      throw new Error("by-id lookup unavailable");
    });
    const brain = createBrain(
      model, grounding, undefined, undefined, undefined, undefined,
      false, false, false, false,
      fakeRetriever(), true, 12,
      false, false, true, false,
    );
    const signals: Signals = { tenantId: "t1", cart: "has_items", cartItems: [{ productId: "p-serum", quantity: 1 }] };
    const decision = await brain.decide(signals, ASK);
    expect(system()).not.toContain("=== SHOPPER CART");
    expect(decision.flags).toContain("cart:byid_unavailable");
    expect(decision.reply.length).toBeGreaterThan(0);
  });

  it("through the PRODUCTION caching wrapper, a fetch failure STILL fires cart:byid_unavailable (not a silent drop)", async () => {
    // In production the brain receives the caching-WRAPPED port (widget-backend/src/model.ts), not the raw
    // adapter. A wrapper that swallowed the by-id failure to `[]` would drop the cart block with NO flag —
    // the exact silent degrade the security review caught. This pins that the wrapped path propagates the
    // failure so the brain's cart:byid_unavailable audit flag fires on a real Shopify outage.
    const { model, system } = capturingModel();
    const inner = shellOnlyGroundingWithByIds(async () => {
      throw new Error("by-id lookup unavailable");
    });
    const wrapped = createCachingGroundingPort(inner, new InMemoryRuntimeStore(), { ttlSeconds: 60 });
    const brain = createBrain(
      model, wrapped, undefined, undefined, undefined, undefined,
      false, false, false, false,
      fakeRetriever(), true, 12,
      false, false, true, false,
    );
    const signals: Signals = { tenantId: "t1", cart: "has_items", cartItems: [{ productId: "p-serum", quantity: 1 }] };
    const decision = await brain.decide(signals, ASK);
    expect(system()).not.toContain("=== SHOPPER CART");
    expect(decision.flags).toContain("cart:byid_unavailable");
    expect(decision.reply.length).toBeGreaterThan(0);
  });

  it("retrieval ON + cart OFF is byte-identical to retrieval ON with no cartItems", async () => {
    const withItemsProbe = capturingModel();
    const bareProbe = capturingModel();
    let byIdCalls = 0;
    const makeGrounding = (): GroundingPortWithByIds =>
      shellOnlyGroundingWithByIds(async (_tenantId, ids) => {
        byIdCalls++;
        return ids.map((id) => ({ id, title: `Title for ${id}`, price: "$1", description: "" }));
      });
    const brainWithCartItems = createBrain(
      withItemsProbe.model, makeGrounding(), undefined, undefined, undefined, undefined,
      false, false, false, false,
      fakeRetriever(), true, 12,
      false, false, false, false, // cartLineItemsEnabled OFF
    );
    await brainWithCartItems.decide(
      { tenantId: "t1", cart: "has_items", cartItems: [{ productId: "p-serum", quantity: 1 }] },
      ASK,
    );
    const brainBare = createBrain(
      bareProbe.model, makeGrounding(), undefined, undefined, undefined, undefined,
      false, false, false, false,
      fakeRetriever(), true, 12,
      false, false, false, false, // cartLineItemsEnabled OFF, and no cartItems supplied at all
    );
    await brainBare.decide({ tenantId: "t1", cart: "has_items" }, ASK);
    expect(byIdCalls).toBe(0);
    expect(withItemsProbe.system()).toBe(bareProbe.system());
  });
});
