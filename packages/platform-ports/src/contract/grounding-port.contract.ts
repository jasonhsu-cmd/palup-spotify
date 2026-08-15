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

    it("getShell returns the same brand + policy as getContext, without products", async () => {
      const a = makeAdapter();
      const ctx = await a.getContext("demo");
      const shell = await a.getShell("demo");
      expect(shell.tenantId).toBe(ctx.tenantId);
      expect(shell.brandName).toBe(ctx.brandName);
      expect(shell.policy).toEqual(ctx.policy);
      expect("products" in (shell as object)).toBe(false);
    });
  });
}
