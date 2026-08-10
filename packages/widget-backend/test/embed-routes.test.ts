import { describe, it, expect, afterEach } from "vitest";
import { InMemoryRuntimeStore, createInMemoryMerchantRegistry, createInMemoryVectorStore } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";

// Task 1 — `?shop=` tenant resolution on the mint route. `/widget/token` must mint for a shop domain
// (the Shopify storefront's own host) exactly as it already does for a publishable embed key: through
// `merchants.tenantForShopDomain`, which is registry-first with `SHOPIFY_STORES` as the named env
// fallback (merchant-resolver.ts:567). `WIDGET_TOKEN_SECRET` must be set too — the route 401s on ANY
// non-`ok` resolution OR an unconfigured signer (server.ts:1094), so a happy-path 200 needs both.
const ENV = ["WIDGET_EMBED_KEYS", "SHOPIFY_STORES", "WIDGET_TOKEN_SECRET", "GUEST_TOKEN_SECRET"];
afterEach(() => ENV.forEach((k) => delete process.env[k]));

async function server(over: Record<string, string> = {}) {
  process.env.WIDGET_EMBED_KEYS = '{"demo-embed-key":"demo"}';
  process.env.SHOPIFY_STORES = '{"demo":"acme.myshopify.com"}';
  process.env.WIDGET_TOKEN_SECRET = "widget-signing-secret";
  for (const [k, v] of Object.entries(over)) process.env[k] = v;
  return buildServer({ store: new InMemoryRuntimeStore(), merchantRegistry: createInMemoryMerchantRegistry(), vectorPort: createInMemoryVectorStore() });
}

describe("mint by shop domain", () => {
  it("mints a token for a known shop domain (?shop=)", async () => {
    const app = await server();
    const res = await app.inject({ method: "GET", url: "/widget/token?shop=acme.myshopify.com" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).token).toBeTruthy();
    await app.close();
  });
  it("401s an unknown shop domain", async () => {
    const app = await server();
    const res = await app.inject({ method: "GET", url: "/widget/token?shop=stranger.myshopify.com" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
  it("still mints via ?key= (unchanged)", async () => {
    const app = await server();
    const res = await app.inject({ method: "GET", url: "/widget/token?key=demo-embed-key" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe("embed routes", () => {
  it("GET /embed/loader.js serves JS", async () => {
    const app = await server();
    const res = await app.inject({ method: "GET", url: "/embed/loader.js" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("javascript");
    expect(res.body.length).toBeGreaterThan(100);
    await app.close();
  });

  it("GET /embed/panel serves HTML embeddable on the shop, not hostilely", async () => {
    const app = await server();
    const res = await app.inject({ method: "GET", url: "/embed/panel?shop=acme.myshopify.com" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    const csp = String(res.headers["content-security-policy"] || "");
    expect(csp).toContain("frame-ancestors");
    expect(csp).toContain("acme.myshopify.com");
    expect(res.headers["x-frame-options"]).toBeUndefined();
    await app.close();
  });
});
