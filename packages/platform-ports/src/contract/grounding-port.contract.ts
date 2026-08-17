import { describe, it, expect } from "vitest";
import type { GroundingPort } from "../grounding-port.js";

// Cart/retrieval coexistence (CART_LINE_ITEMS + CATALOG_RETRIEVAL) — the new by-id fetch the render
// path needs to resolve cart line items without paging the whole catalog. Typed as an OPTIONAL extra
// here (not yet on `GroundingPort` itself) so this contract file compiles against today's port while
// still exercising the real adapter method once it exists. See
// packages/widget-brain/test/cart-retrieval-coexist.test.ts for the brain-side wiring tests.
type GroundingPortWithByIds = GroundingPort & {
  getProductsByIds?(tenantId: string, ids: string[]): Promise<import("../grounding-port.js").Product[]>;
};

// Every GroundingPort adapter must pass this (ADR-0001).
export function runGroundingPortContract(makeAdapter: () => GroundingPort): void {
  describe("GroundingPort contract", () => {
    it("returns a branded, non-empty catalog for a tenant", async () => {
      const ctx = await makeAdapter().getContext("demo");
      expect(ctx.tenantId).toBe("demo");
      expect(ctx.brandName.length).toBeGreaterThan(0);
      expect(ctx.products.length).toBeGreaterThan(0);
    });

    it("every product has a title and a price string", async () => {
      const ctx = await makeAdapter().getContext("demo");
      for (const p of ctx.products) {
        expect(p.title.length).toBeGreaterThan(0);
        expect(p.price.length).toBeGreaterThan(0);
      }
    });

    it("getShell returns the same brand + policy as getContext, without products", async () => {
      const a = makeAdapter();
      const ctx = await a.getContext("demo");
      const shell = await a.getShell("demo");
      expect(shell.tenantId).toBe(ctx.tenantId);
      expect(shell.brandName).toBe(ctx.brandName);
      expect(shell.policy).toEqual(ctx.policy);
      expect("products" in (shell as object)).toBe(false);
    });

    // Cart/retrieval coexistence — the render path (S2) fetches only a brand/policy SHELL, so a cart
    // line item cannot be resolved against `ctx.products` (there are none). `getProductsByIds` is the
    // bounded by-id fetch that resolves it instead. Contract: tenant-scoped; unknown/delisted ids are
    // OMITTED (never throw, never placeholder) — the same null-drop contract as Shopify's `nodes(ids:)`.
    it("getProductsByIds returns exactly the requested resolvable products, omitting unknown ids", async () => {
      const adapter = makeAdapter() as GroundingPortWithByIds;
      if (typeof adapter.getProductsByIds !== "function") {
        throw new Error("GroundingPort.getProductsByIds is not implemented on this adapter");
      }
      const products = await adapter.getProductsByIds("demo", ["cleanser-gentle", "does-not-exist"]);
      expect(products).toHaveLength(1);
      expect(products[0]!.id).toBe("cleanser-gentle");
      expect(products.some((p) => p.id === "does-not-exist")).toBe(false);
    });
  });
}
