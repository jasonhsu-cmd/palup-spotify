import { describe, it, expect } from "vitest";
import type { CartPort, CartLine, CartCheckout } from "../src/cart-port.js";

// Pillar 2a — CartPort (ADR-0001 port). Type-only shape: no logic lives on the port itself (adapters
// carry the logic — see `packages/widget-backend/test/cart-permalink-adapter.test.ts` for the real
// permalink adapter's behaviour). This test just proves the interface compiles and is usable end-to-end
// via a tiny in-memory fake, so the port is exercised even though it has no logic of its own.

function createFakeCartPort(validVariantIds: Set<string>): CartPort {
  return {
    async createCheckout(lines: CartLine[]): Promise<CartCheckout | null> {
      const valid = lines.filter((l) => validVariantIds.has(l.variantId) && l.quantity >= 1);
      if (valid.length === 0) return null;
      return { checkoutUrl: `https://fake.example/cart/${valid.map((l) => `${l.variantId}:${l.quantity}`).join(",")}` };
    },
  };
}

describe("CartPort (shape)", () => {
  it("resolves a checkout for valid lines", async () => {
    const port = createFakeCartPort(new Set(["111", "222"]));
    const result = await port.createCheckout([
      { variantId: "111", quantity: 2 },
      { variantId: "222", quantity: 1 },
    ]);
    expect(result).toEqual({ checkoutUrl: "https://fake.example/cart/111:2,222:1" });
  });

  it("returns null when no valid line resolves", async () => {
    const port = createFakeCartPort(new Set(["111"]));
    const result = await port.createCheckout([{ variantId: "999", quantity: 1 }]);
    expect(result).toBeNull();
  });

  it("returns null for empty lines", async () => {
    const port = createFakeCartPort(new Set(["111"]));
    const result = await port.createCheckout([]);
    expect(result).toBeNull();
  });
});
