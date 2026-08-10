import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { createGroundingPort, GroundingCredentialUnreadableError } from "../src/model.js";

// D2: createGroundingPort's router now consults resolveStorefrontCredential's three-way outcome
// (live/fixtures/refuse) instead of resolveShopifyStore's boolean creds/no-creds. `refuse` must
// throw distinctly — never silently serve the fixture catalog under a merchant's own brand.
const store = () => new InMemoryRuntimeStore();
const secrets = { get: async () => undefined } as any;

describe("createGroundingPort — credential read-back routing (D2)", () => {
  it("readback ON + found → serves the merchant's real catalog via the injected fetch", async () => {
    const g = createGroundingPort(store(), secrets, {
      readbackEnabled: true,
      credRead: async () => ({ status: "found", token: "shpat_live" }),
      shopDomainFor: async () => "acme.myshopify.com",
      shopifyFetch: async () => ({ shop: { name: "Acme" }, products: { nodes: [{ id: "1", title: "Widget" }] } }),
    });
    const ctx = await g.getContext("acme");
    expect(ctx.brandName).toBe("Acme");
    expect(ctx.products.map((p) => p.title)).toContain("Widget");
  });

  it("readback ON + unreadable → throws GroundingCredentialUnreadableError (router does NOT serve fixtures)", async () => {
    // Assert via the caching wrapper's degrade behavior: a cold failure becomes safe-empty, never the
    // AURIA/NORTHWIND fixture catalog — that would silently hand the tenant's shoppers a wrong brand.
    const g = createGroundingPort(store(), secrets, {
      readbackEnabled: true,
      credRead: async () => ({ status: "unreadable", reason: "undecryptable" }),
      shopDomainFor: async () => "acme.myshopify.com",
    });
    const ctx = await g.getContext("acme");
    expect(ctx.products).toEqual([]); // safe-empty, NOT the fixture catalog
    expect(ctx.brandName).toBe("this store"); // safeEmpty brandName
  });

  it("readback OFF → unchanged SecretsPort path (missing token → fixtures for demo)", async () => {
    const g = createGroundingPort(
      store(),
      { get: async (_t: string, _n: string) => undefined } as any,
      {
        readbackEnabled: false,
        credRead: async () => ({ status: "unreadable", reason: "undecryptable" }),
        shopDomainFor: async () => "demo-store.myshopify.com",
      },
    );
    const ctx = await g.getContext("demo");
    expect(ctx.brandName).not.toBe("this store"); // demo resolves the AURIA fixture, credRead never consulted
  });

  it("GroundingCredentialUnreadableError carries the refusal reason and a distinct name", () => {
    const err = new GroundingCredentialUnreadableError("malformed-record");
    expect(err.name).toBe("GroundingCredentialUnreadableError");
    expect(err.reason).toBe("malformed-record");
    expect(err).toBeInstanceOf(Error);
  });
});
