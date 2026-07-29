import { describe, it, expect, afterEach } from "vitest";
import { InMemoryRuntimeStore, createEnvSecrets } from "@palup/platform-ports";
import { createGroundingPort } from "../src/model.js";
import { SHOPIFY_TOKEN_SECRET } from "../src/merchant-store.js";

// createGroundingPort routes per-tenant: Shopify when creds resolve, else fixtures — all behind the
// caching wrapper. During rollout no tenant has creds ⇒ everyone gets fixtures.
afterEach(() => delete process.env.SHOPIFY_STORES);

describe("createGroundingPort composition", () => {
  it("falls back to fixtures when a tenant has no Shopify credentials", async () => {
    const g = createGroundingPort(new InMemoryRuntimeStore(), createEnvSecrets(undefined));
    expect((await g.getContext("demo")).brandName).toBe("Auria"); // fixture
    expect((await g.getContext("northwind")).brandName).toBe("Northwind Coffee");
    expect((await g.getContext("unknown-tenant")).products).toEqual([]); // safe-empty
  });

  it("routes a credential-configured tenant to Shopify, and degrades safely while the live fetch is unimplemented", async () => {
    process.env.SHOPIFY_STORES = JSON.stringify({ acme: "acme.myshopify.com" });
    const secrets = createEnvSecrets(JSON.stringify({ acme: { [SHOPIFY_TOKEN_SECRET]: "shptok" } }));
    const g = createGroundingPort(new InMemoryRuntimeStore(), secrets);
    // acme is Shopify-configured → routed to the Shopify adapter → live fetch not implemented → the
    // caching wrapper fails closed to safe-empty (never a crash, never another tenant's catalog).
    const acme = await g.getContext("acme");
    expect(acme.tenantId).toBe("acme");
    expect(acme.products).toEqual([]);
    // a DIFFERENT, unconfigured tenant still gets its fixture (routing is per-tenant + isolated).
    expect((await g.getContext("demo")).brandName).toBe("Auria");
  });
});
