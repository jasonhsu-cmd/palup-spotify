import { describe, it, expect, afterEach, vi } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";

// Task 2 (Workstream B, SSR first page) — proves the buildServer composition-root wiring of `GET /`:
// the storefront-catalog deps (resolveTenant/getCatalogPage/shopDomainFor/allowTenant) already built for
// `/storefront/catalog` are reused (no second fetch path, no second limiter) to server-render the FIRST
// page into the static `home.html` shell. Mirrors the pattern in `storefront-catalog-route.test.ts`'s
// "buildServer wiring" describe block.

// The default tenant `/` resolves has no `?shop` — it is the SINGLE configured `SHOPIFY_STORES` shop
// domain (the same one `app.js` defaults its own `SHOP` constant to when the page carries no
// `data-shop`), so setting `SHOPIFY_STORES` to that exact domain is what makes `/` resolve at all.
const DEFAULT_SHOP_DOMAIN = "palup-skincare-jason.myshopify.com";
const TENANT = "demo";
const CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=600";

const ENV_KEYS = ["SHOPIFY_STORES", "PALUP_SECRETS", "MERCHANT_CRED_READBACK_ENABLED", "WIDGET_EMBED_KEYS"] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("GET / server-renders the first catalog page (SSR)", () => {
  it("SSRs the first page when the default tenant resolves: #palup-ssr present, real brand in <title>, no {brand}", async () => {
    process.env.SHOPIFY_STORES = JSON.stringify({ [TENANT]: DEFAULT_SHOP_DOMAIN });

    const app = await buildServer({ store: new InMemoryRuntimeStore() });
    try {
      const res = await app.inject({ method: "GET", url: "/" });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('id="palup-ssr"');
      expect(res.headers["cache-control"]).toBe(CACHE_CONTROL);
      // The "demo" tenant's built-in fixture (static-grounding.ts) is the "Auria" store — no live
      // Shopify credential is provisioned in this test, so grounding falls back to it (same posture as
      // server-readback.test.ts's "flag OFF" case).
      expect(res.body).toContain("<title>Auria");
      // Check the visible `{brand}` FOUC surface (the <title>), not the whole body — the CLS fix
      // (Task 3) inlines app.js's own source into this response (storefront-ssr.ts
      // `inlineStorefrontScript`), and app.js legitimately carries the literal string `"{brand}"` as
      // its own client-side fallback substitution for non-SSR pages; that text lives inside a <script>
      // tag and is never rendered, so it isn't a FOUC.
      const title = res.body.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
      expect(title).not.toContain("{brand}");
      const jsonMatch = res.body.match(/<script id="palup-ssr" type="application\/json">([^<]*)<\/script>/);
      expect(jsonMatch).not.toBeNull();
      const payload = JSON.parse(jsonMatch![1]!);
      expect(payload.brandName).toBe("Auria");
      expect(Array.isArray(payload.products)).toBe(true);
      expect(payload.products.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it("falls back to the static shell, still 200, when the default tenant does not resolve (no SHOPIFY_STORES configured)", async () => {
    const app = await buildServer({ store: new InMemoryRuntimeStore() });
    try {
      const res = await app.inject({ method: "GET", url: "/" });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("<!doctype html>");
      expect(res.body).not.toContain('id="palup-ssr"');
      expect(res.body).toContain("{brand}"); // raw, unmodified static shell
      // The degraded shell is STILL cacheable (same header as the SSR-success path) — a 429-avoidance
      // path must not also force every hit to bypass the CDN/browser cache.
      expect(res.headers["cache-control"]).toBe(CACHE_CONTROL);
    } finally {
      await app.close();
    }
  });

  it("falls back to the static shell, still 200, when the first-page fetch throws (no live network call)", async () => {
    // A resolvable tenant + a live Storefront token, but a shop domain that is NOT a *.myshopify.com
    // host: `resolveStorefrontCredential` (no read-back configured here) resolves this to a "live"
    // outcome, so `getCatalogPage` reaches `storefrontCatalogPageFetch`'s own `SHOP_HOST` guard, which
    // throws SYNCHRONOUSLY (shopify-grounding.ts) before ever calling `fetch` — a genuine, deterministic
    // "the first-page fetch throws" case with no real network egress.
    const BAD_SHOP_DOMAIN = "not-a-real-shop.example.com";
    process.env.SHOPIFY_STORES = JSON.stringify({ [TENANT]: BAD_SHOP_DOMAIN });
    process.env.PALUP_SECRETS = JSON.stringify({ [TENANT]: { shopify_storefront_token: "shpat_ssr_home_test_token" } });

    const app = await buildServer({ store: new InMemoryRuntimeStore() });
    try {
      const res = await app.inject({ method: "GET", url: "/" });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("<!doctype html>");
      expect(res.body).not.toContain('id="palup-ssr"');
      expect(res.body).toContain("{brand}");
    } finally {
      await app.close();
    }
  });

  it("skips SSR (raw shell, still 200, no live fetch) when the per-tenant limiter denies — the SAME denial-of-wallet backstop `/storefront/catalog` uses, never a second one", async () => {
    // A resolvable tenant with a fully-live-looking config (a *.myshopify.com domain + a Storefront
    // token) — if the limiter did NOT gate this path, `getCatalogPage` would reach the live branch and
    // attempt a real `fetch` to `DEFAULT_SHOP_DOMAIN`. Spying on `globalThis.fetch` proves it never does.
    process.env.SHOPIFY_STORES = JSON.stringify({ [TENANT]: DEFAULT_SHOP_DOMAIN });
    process.env.PALUP_SECRETS = JSON.stringify({ [TENANT]: { shopify_storefront_token: "shpat_deny_test_token" } });

    const store = new InMemoryRuntimeStore();
    // `RL_TENANT` (server.ts) is a MODULE-LEVEL const read from `RL_TENANT_PER_MIN` at first import — by
    // the time an `it()` body runs, `server.ts` is already imported, so setting the env var here would
    // have NO effect on the limit actually in force. Instead, pre-consume the real default ceiling
    // (2_000 — `posInt("RL_TENANT_PER_MIN", 2_000)`) directly on the SAME bucket key
    // ("storefront-catalog") + tenant ("demo") + window (default 60s) that `storefrontAllowTenant` checks,
    // so the route's own `underLimit` call (the 2001st hit) is what tips it over — exactly the real
    // "prior traffic already spent the budget" case, not a synthetic short-circuit.
    for (let i = 0; i < 2_000; i++) {
      await store.incrementWindow({ tenantId: TENANT }, "storefront-catalog", 60);
    }

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch must not be called"));
    try {
      const app = await buildServer({ store });
      try {
        const res = await app.inject({ method: "GET", url: "/" });
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain("<!doctype html>");
        expect(res.body).not.toContain('id="palup-ssr"');
        expect(res.body).toContain("{brand}"); // raw, unmodified static shell
        expect(res.headers["cache-control"]).toBe(CACHE_CONTROL);
        // The clearest proof `getCatalogPage`'s live branch was never reached: no outbound fetch at all.
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
