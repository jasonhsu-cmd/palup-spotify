import { describe, it, expect, afterEach } from "vitest";
import { InMemoryRuntimeStore, createInMemoryMerchantRegistry, createInMemoryVectorStore } from "@palup/platform-ports";
import type { MerchantRegistryPort } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";

// Task 1 — `?shop=` tenant resolution on the mint route. `/widget/token` must mint for a shop domain
// (the Shopify storefront's own host) exactly as it already does for a publishable embed key: through
// `merchants.tenantForShopDomain`, which is registry-first with `SHOPIFY_STORES` as the named env
// fallback (merchant-resolver.ts:567). `WIDGET_TOKEN_SECRET` must be set too — the route 401s on ANY
// non-`ok` resolution OR an unconfigured signer (server.ts:1094), so a happy-path 200 needs both.
const ENV = [
  "WIDGET_EMBED_KEYS",
  "SHOPIFY_STORES",
  "SHOPIFY_PRIMARY_DOMAINS",
  "WIDGET_TOKEN_SECRET",
  "GUEST_TOKEN_SECRET",
  "PALUP_E2E_FIXTURES",
  "PORT",
];
afterEach(() => ENV.forEach((k) => delete process.env[k]));

async function server(over: Record<string, string> = {}, registry: MerchantRegistryPort = createInMemoryMerchantRegistry()) {
  process.env.WIDGET_EMBED_KEYS = '{"demo-embed-key":"demo"}';
  process.env.SHOPIFY_STORES = '{"demo":"acme.myshopify.com"}';
  process.env.WIDGET_TOKEN_SECRET = "widget-signing-secret";
  for (const [k, v] of Object.entries(over)) process.env[k] = v;
  return buildServer({ store: new InMemoryRuntimeStore(), merchantRegistry: registry, vectorPort: createInMemoryVectorStore() });
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

  // Precedence documentation (server.ts:1195: `q.shop ? tenantForShopDomain(q.shop) : resolveEmbedKey(...)`
  // — `?key=` is never even READ when `?shop=` is present). When BOTH are sent, `?shop=` must win: the
  // shop's own tenant is minted, never the (here deliberately DIFFERENT) tenant `?key=` would resolve to.
  // A registry-backed second tenant is used (rather than a second WIDGET_EMBED_KEYS entry) so the two
  // resolution paths are unambiguously distinguishable by which tenant ends up signed into the token.
  it("?shop= wins when BOTH ?shop= and ?key= are sent — the shop's tenant is minted, not the key's", async () => {
    const registry = createInMemoryMerchantRegistry();
    await registry.create({
      tenantId: "beta",
      shopDomain: "beta.myshopify.com",
      embedKey: "beta-embed-key",
      region: "us",
    });
    const app = await server({}, registry);
    try {
      // `?key=demo-embed-key` alone resolves to "demo" (see the `?key=`-only test above); `?shop=` here
      // points at a DIFFERENT tenant ("beta"). Sending both must resolve to "beta", proving `?shop=` takes
      // precedence rather than either an OR-of-both-succeeding or the key silently winning.
      const res = await app.inject({
        method: "GET",
        url: "/widget/token?shop=beta.myshopify.com&key=demo-embed-key",
      });
      expect(res.statusCode).toBe(200);
      const { token } = JSON.parse(res.body) as { token: string };
      // Token shape is `body.sig` (widget-token-identity.ts's mintWidgetToken) — decode the body, not a
      // JWT-style middle segment, and read the tenant off its `m` (merchantId) claim.
      const claims = JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8")) as { m: string };
      expect(claims.m).toBe("beta");
      expect(claims.m).not.toBe("demo");
    } finally {
      await app.close();
    }
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

  // Task 5 — the panel HTML must actually carry the panel-mode CSS hook and speak the loader's
  // postMessage protocol. The inline-script UI itself isn't unit-testable without refactoring the panel
  // into modules (out of scope, see task-5-brief.md); this is the served-HTML marker check that stands
  // in for it, plus a later e2e.
  it("panel HTML carries the panel-mode + postMessage wiring", async () => {
    const app = await server();
    const res = await app.inject({ method: "GET", url: "/embed/panel?shop=acme.myshopify.com" });
    expect(res.body).toContain("data-palup-panel");
    expect(res.body).toContain("palup:ready");
    await app.close();
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// Custom-domain CSP support. The panel's `frame-ancestors` widens to include a merchant's SERVER-
// RESOLVED custom (primary) domain — reached ONLY via `merchants.primaryDomainForShop(shop)`, itself
// keyed by the already-accepted `?shop=`, NEVER a second client-supplied parameter. See the design note:
// .superpowers/sdd/2026-08-10-embeddable-widget/custom-domain-design.md.
describe("/embed/panel CSP — custom-domain support (server-resolved ONLY, never client-supplied)", () => {
  it("a registry row's primaryDomain widens frame-ancestors to include the custom domain", async () => {
    const registry = createInMemoryMerchantRegistry();
    await registry.create({
      tenantId: "acme",
      shopDomain: "acme.myshopify.com",
      embedKey: "pk-acme",
      region: "us",
      primaryDomain: "shop.acme-brand.com",
    });
    const app = await server({}, registry);
    const res = await app.inject({ method: "GET", url: "/embed/panel?shop=acme.myshopify.com" });
    const csp = String(res.headers["content-security-policy"] || "");
    expect(csp).toContain("https://acme.myshopify.com");
    expect(csp).toContain("https://*.myshopify.com");
    expect(csp).toContain("https://shop.acme-brand.com");
    await app.close();
  });

  it("with NO registry row, the named SHOPIFY_PRIMARY_DOMAINS env fallback widens the CSP the same way", async () => {
    const app = await server({ SHOPIFY_PRIMARY_DOMAINS: JSON.stringify({ "acme.myshopify.com": "shop.acme-brand.com" }) });
    const res = await app.inject({ method: "GET", url: "/embed/panel?shop=acme.myshopify.com" });
    const csp = String(res.headers["content-security-policy"] || "");
    expect(csp).toContain("https://shop.acme-brand.com");
    await app.close();
  });

  it("NEGATIVE — an unrelated ?customDomain=evil.com is NEVER a second input into the CSP", async () => {
    const registry = createInMemoryMerchantRegistry();
    await registry.create({
      tenantId: "acme",
      shopDomain: "acme.myshopify.com",
      embedKey: "pk-acme",
      region: "us",
      primaryDomain: "shop.acme-brand.com",
    });
    const app = await server({}, registry);
    const res = await app.inject({ method: "GET", url: "/embed/panel?shop=acme.myshopify.com&customDomain=evil.com" });
    const csp = String(res.headers["content-security-policy"] || "");
    expect(csp).not.toContain("evil.com");
    expect(csp).toContain("shop.acme-brand.com"); // the SERVER-resolved domain still applies
    await app.close();
  });

  it("no-domain regression: a shop with no primaryDomain configured anywhere gets the unchanged CSP", async () => {
    const app = await server(); // registry present but empty, and no SHOPIFY_PRIMARY_DOMAINS
    const res = await app.inject({ method: "GET", url: "/embed/panel?shop=acme.myshopify.com" });
    const csp = String(res.headers["content-security-policy"] || "");
    expect(csp).toBe("frame-ancestors https://acme.myshopify.com https://*.myshopify.com");
    await app.close();
  });

  it("F1 — a missing/malformed ?shop= now denies framing ('none'), not the old permissive 'https:'", async () => {
    const app = await server();
    const res = await app.inject({ method: "GET", url: "/embed/panel" });
    expect(String(res.headers["content-security-policy"] || "")).toBe("frame-ancestors 'none'");
    const res2 = await app.inject({ method: "GET", url: "/embed/panel?shop=not-a-shop" });
    expect(String(res2.headers["content-security-policy"] || "")).toBe("frame-ancestors 'none'");
    await app.close();
  });

  it("the task-7 e2e fixture widening still lands LAST, even after a custom domain is appended", async () => {
    const registry = createInMemoryMerchantRegistry();
    await registry.create({
      tenantId: "acme",
      shopDomain: "acme.myshopify.com",
      embedKey: "pk-acme",
      region: "us",
      primaryDomain: "shop.acme-brand.com",
    });
    const app = await server({ PALUP_E2E_FIXTURES: "true", PORT: "8888" }, registry);
    const res = await app.inject({ method: "GET", url: "/embed/panel?shop=acme.myshopify.com" });
    const csp = String(res.headers["content-security-policy"] || "");
    expect(csp).toBe(
      "frame-ancestors https://acme.myshopify.com https://*.myshopify.com https://shop.acme-brand.com http://127.0.0.1:8888",
    );
    await app.close();
  });
});
