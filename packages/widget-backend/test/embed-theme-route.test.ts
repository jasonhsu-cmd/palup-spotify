import { describe, it, expect, afterEach } from "vitest";
import { InMemoryRuntimeStore, createInMemoryMerchantRegistry, createInMemoryVectorStore } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";
import { BRAND_CACHE_COLLECTION, BRAND_CACHE_KEY } from "../src/brand-cache.js";

// WS10 — the panel HTML gets the merchant brand theme injected FOUC-free at <!--PALUP_THEME-->, and the
// loader's launcher reads GET /embed/theme. Theme is resolved server-side by shop → tenant (never client).
const ENV = ["WIDGET_EMBED_KEYS", "SHOPIFY_STORES", "WIDGET_TOKEN_SECRET"];
afterEach(() => ENV.forEach((k) => delete process.env[k]));

async function server(seedBrandName?: string) {
  process.env.WIDGET_EMBED_KEYS = '{"demo-embed-key":"palup-skincare-jason"}';
  process.env.SHOPIFY_STORES = '{"palup-skincare-jason":"palup-skincare-jason.myshopify.com"}';
  process.env.WIDGET_TOKEN_SECRET = "widget-signing-secret";
  const store = new InMemoryRuntimeStore();
  if (seedBrandName) {
    // Pillar 5 (auto-brand) — the panel header name is resolved from the merchant's REAL Shopify shop name
    // and cached on the RuntimeStatePort; it is NOT hardcoded per tenant. This harness has no live Shopify
    // grounding, so seed the cache directly (a real deployment fills it from getShell once per tenant/TTL).
    await store.put({ tenantId: "palup-skincare-jason" }, BRAND_CACHE_COLLECTION, BRAND_CACHE_KEY, {
      brandName: seedBrandName,
      fetchedAtMs: Date.now(),
    });
  }
  return buildServer({
    store,
    merchantRegistry: createInMemoryMerchantRegistry(),
    vectorPort: createInMemoryVectorStore(),
  });
}

describe("WS10 — GET /embed/theme", () => {
  it("returns the resolved brand + ink for a known shop (hex, cacheable, CORS-open, no secret)", async () => {
    const app = await server();
    const res = await app.inject({ method: "GET", url: "/embed/theme?shop=palup-skincare-jason.myshopify.com" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.headers["cache-control"]).toContain("max-age");
    const body = JSON.parse(res.body);
    expect(body.brand).toMatch(/^#[0-9a-f]{6}$/i);
    expect(["#ffffff", "#000000"]).toContain(body.brandInk);
    expect(Object.keys(body).sort()).toEqual(["brand", "brandInk"]); // only the two colours the bubble needs
    await app.close();
  });

  it("falls back to the default indigo theme for an unknown shop (no oracle, no error)", async () => {
    const app = await server();
    const res = await app.inject({ method: "GET", url: "/embed/theme?shop=stranger.myshopify.com" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).brand).toBe("#4f46e5"); // DEFAULT_THEME
    await app.close();
  });
});

describe("WS10 — /embed/panel theme injection", () => {
  it("replaces the marker with a validated :root override + the theme script (no raw marker left)", async () => {
    const app = await server("Auria");
    const res = await app.inject({ method: "GET", url: "/embed/panel?shop=palup-skincare-jason.myshopify.com" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("<!--PALUP_THEME-->");
    expect(res.body).toContain('id="palup-theme"');
    expect(res.body).toMatch(/:root\{--brand:#[0-9a-f]{6}/i);
    expect(res.body).toContain("window.PALUP");
    expect(res.body).toContain('"brandName":"Auria"'); // resolved from the merchant's real shop name + cached (Pillar 5), NOT hardcoded
    // the embedded chat is pinned light-toned (owner directive) so it matches the light storefront and
    // never darkens on a dark-OS shopper; the /widget a11y harness (below) stays theme-aware.
    expect(res.body).toContain('<html lang="en" data-theme="light">');
    await app.close();
  });

  it("injects the default indigo theme + NO brand name for an unknown/absent shop (no hardcoding)", async () => {
    const app = await server();
    const res = await app.inject({ method: "GET", url: "/embed/panel" });
    expect(res.body).toContain('id="palup-theme"');
    expect(res.body).toMatch(/--brand:#4f46e5/i);
    // Pillar 5 — an unresolved shop injects an EMPTY theme meta: no brand name is hardcoded or invented, the
    // client falls back to its neutral default. (Was: a curated "Auria" leaked here from THEME_CONFIGS.)
    expect(res.body).toContain("{theme:{}}");
    await app.close();
  });

  it("the /widget harness leaves the marker unthemed (default widget for the a11y/widget suites)", async () => {
    const app = await server();
    const res = await app.inject({ method: "GET", url: "/widget" });
    // /widget serves the raw widgetHtml — no server-side theme injection; the marker stays a plain comment.
    expect(res.body).toContain("<!--PALUP_THEME-->");
    expect(res.body).not.toContain('id="palup-theme"');
    // the harness stays theme-aware (no forced-light pin on <html>) so the a11y suite can still exercise
    // dark mode. (The CSS guard `:root:not([data-theme="light"])` contains the substring — assert the tag.)
    expect(res.body).not.toContain('<html lang="en" data-theme="light">');
    await app.close();
  });
});
