import { describe, it, expect, afterEach } from "vitest";
import { InMemoryRuntimeStore, createInMemoryMerchantRegistry, createInMemoryVectorStore } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";

// WS3 — the sample storefront replaces the inlined widget demo at `/`; the widget moves to `/widget`
// (test/dev harness) and is embedded on the storefront via the real /embed/loader.js snippet.
const ENV = ["WIDGET_EMBED_KEYS", "SHOPIFY_STORES", "WIDGET_TOKEN_SECRET"];
afterEach(() => ENV.forEach((k) => delete process.env[k]));

async function server() {
  process.env.WIDGET_TOKEN_SECRET = "widget-signing-secret";
  return buildServer({
    store: new InMemoryRuntimeStore(),
    merchantRegistry: createInMemoryMerchantRegistry(),
    vectorPort: createInMemoryVectorStore(),
  });
}

describe("WS3 — storefront routes", () => {
  it("GET / serves the storefront (real loader snippet + data-shop + app.js), NOT the inlined widget", async () => {
    const app = await server();
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain('src="/embed/loader.js"');
    expect(res.body).toContain('data-shop="palup-skincare-jason.myshopify.com"');
    expect(res.body).toContain('src="/storefront/app.js"');
    expect(res.body).not.toContain('id="widget"'); // the widget is embedded via the loader, not inlined
    await app.close();
  });

  it("GET /widget still serves the standalone widget harness (for the widget/a11y suites)", async () => {
    const app = await server();
    const res = await app.inject({ method: "GET", url: "/widget" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('id="widget"');
    expect(res.body).toContain('id="launcher"');
    await app.close();
  });

  it("GET /product/:handle and GET /cart serve their storefront pages", async () => {
    const app = await server();
    const p = await app.inject({ method: "GET", url: "/product/vitamin-c-serum" });
    const c = await app.inject({ method: "GET", url: "/cart" });
    expect(p.statusCode).toBe(200);
    expect(p.headers["content-type"]).toContain("text/html");
    expect(p.body).toContain('id="pdp"');
    expect(c.statusCode).toBe(200);
    expect(c.body).toContain('id="cart"');
    await app.close();
  });

  it("serves the storefront assets with correct content-types", async () => {
    const app = await server();
    const css = await app.inject({ method: "GET", url: "/storefront/app.css" });
    const js = await app.inject({ method: "GET", url: "/storefront/app.js" });
    expect(css.statusCode).toBe(200);
    expect(css.headers["content-type"]).toContain("text/css");
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toContain("javascript");
    await app.close();
  });
});
