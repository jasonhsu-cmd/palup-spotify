import { describe, it, expect, vi } from "vitest";
import type { GroundingPort, ModelPort, ModelRequest } from "@palup/platform-ports";
import { createBrain, StaticGroundingAdapter } from "../src/index.js";

// M2 slice 1 — the brain must ground on the SERVER-DERIVED request tenant (signals.tenantId), not a
// hardcoded one, so two merchants sharing the (policy-cached) brain get their OWN catalogs.
describe("per-tenant grounding threading", () => {
  const spyGrounding = () => {
    const seen: string[] = [];
    const port: GroundingPort = {
      async getContext(tenantId) {
        seen.push(tenantId);
        return { tenantId, brandName: `T-${tenantId}`, products: [{ id: "p", title: "X", price: "$1", description: "d" }], policy: { returns: "", shipping: "" } };
      },
    };
    return { seen, port };
  };

  it("grounds + tags the model with signals.tenantId", async () => {
    const { seen, port } = spyGrounding();
    const spy = vi.fn<ModelPort["complete"]>(async () => ({ text: "ok", model: "spy" }));
    const brain = createBrain({ complete: spy }, port);

    await brain.decide({ tenantId: "northwind", cart: "has_items" }, "what do you recommend for me?");

    expect(seen).toContain("northwind"); // grounding fetched the request tenant's catalog
    expect(seen.every((t) => t === "northwind")).toBe(true); // never leaks to "demo"
    const req = spy.mock.calls[0]![0] as ModelRequest;
    expect(req.tenantId).toBe("northwind"); // model tenancy tag carries the tenant too
  });

  it("falls back to the demo tenant when no tenantId is present (rollout)", async () => {
    const { seen, port } = spyGrounding();
    const brain = createBrain({ complete: async () => ({ text: "ok", model: "spy" }) }, port);
    await brain.decide({ cart: "has_items" }, "what do you recommend for me?");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((t) => t === "demo")).toBe(true);
  });
});

describe("fixture grounding adapter — multi-tenant + isolation", () => {
  const a = new StaticGroundingAdapter();

  it("serves each tenant its own catalog, with no cross-tenant bleed", async () => {
    const demo = await a.getContext("demo");
    const nw = await a.getContext("northwind");
    expect(demo.brandName).toBe("Auria");
    expect(nw.brandName).toBe("Northwind Coffee");
    expect(demo.products.some((p) => /coffee|beans/i.test(p.title))).toBe(false);
    expect(nw.products.some((p) => /serum|cleanser/i.test(p.title))).toBe(false);
  });

  it("returns a safe-empty context for an unknown tenant — never another merchant's catalog", async () => {
    const unknown = await a.getContext("not-a-real-tenant");
    expect(unknown.tenantId).toBe("not-a-real-tenant");
    expect(unknown.products).toEqual([]);
  });

  it("ignores inherited/prototype keys (safe-empty, not a crash or a bleed)", async () => {
    for (const k of ["__proto__", "constructor", "toString"]) {
      expect((await a.getContext(k)).products).toEqual([]);
    }
  });
});
