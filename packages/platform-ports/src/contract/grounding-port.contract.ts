import { describe, it, expect } from "vitest";
import type { GroundingPort } from "../grounding-port.js";

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
  });
}
