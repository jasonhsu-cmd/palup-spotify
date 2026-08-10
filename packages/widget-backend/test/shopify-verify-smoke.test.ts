import { describe, it, expect } from "vitest";
import { runShopifyVerify } from "../src/shopify-verify-smoke.js";

// Task 6 (D2 read-back plan) — unit coverage for the OPERATOR SMOKE-TEST HARNESS that chains
// exchangeInstallCode → createDelegateAccessToken → storefrontFetch (shopify-install-identity.ts,
// shopify-grounding.ts). No network: `fetchFn` is injected and routed by URL, exactly like
// shopify-install-identity.test.ts / shopify-grounding.test.ts already do for the modules this harness
// only WIRES TOGETHER — it introduces no new wire-format logic of its own.
//
// The one property that matters more than "does it pass": the result object this harness returns must
// NEVER contain a token. That is asserted directly below by stringifying the result and searching for
// both canned secret literals.

const SHOP = "acme-verify.myshopify.com";
const PARENT_TOKEN = "shpat_parent_super_secret";
const DELEGATE_TOKEN = "shpca_delegate_super_secret";

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return { ok: init.ok ?? true, status: init.status ?? 200, json: async () => body } as Response;
}

/** Routes a fake fetch by URL shape, exactly like the three real endpoints this harness calls in order. */
function routedFetch(opts: {
  storefrontOk?: boolean;
  storefrontStatus?: number;
}): typeof globalThis.fetch {
  return (async (url: string) => {
    const u = String(url);
    if (u.includes("/admin/oauth/access_token")) {
      // exchangeInstallCode's expected shape.
      return jsonResponse({ access_token: PARENT_TOKEN, scope: "unauthenticated_read_product_listings,read_products" });
    }
    if (u.includes("/admin/api/")) {
      // createDelegateAccessToken's expected shape (delegateAccessTokenCreate mutation).
      return jsonResponse({
        data: {
          delegateAccessTokenCreate: {
            delegateAccessToken: { accessToken: DELEGATE_TOKEN, accessScopes: ["unauthenticated_read_product_listings"] },
            userErrors: [],
          },
        },
      });
    }
    if (u.includes("/api/")) {
      // storefrontFetch's Storefront GraphQL products query.
      if (opts.storefrontOk === false) {
        return jsonResponse({}, { ok: false, status: opts.storefrontStatus ?? 500 });
      }
      return jsonResponse({ data: { products: { nodes: [{ id: "1" }, { id: "2" }, { id: "3" }] } } });
    }
    throw new Error(`routedFetch: unexpected URL ${u}`);
  }) as unknown as typeof globalThis.fetch;
}

describe("runShopifyVerify", () => {
  it("chains exchange → delegate → storefront and reports ok:true with a product count + scopes", async () => {
    const result = await runShopifyVerify(
      { shopDomain: SHOP, code: "one-time-code", clientId: "client-id", clientSecret: "client-secret" },
      routedFetch({}),
    );
    expect(result).toEqual({
      ok: true,
      productCount: 3,
      grantedScopes: ["unauthenticated_read_product_listings", "read_products"],
      accessScopes: ["unauthenticated_read_product_listings"],
    });
  });

  it("reports ok:false stage:'storefront' when the Storefront call fails", async () => {
    const result = await runShopifyVerify(
      { shopDomain: SHOP, code: "one-time-code", clientId: "client-id", clientSecret: "client-secret" },
      routedFetch({ storefrontOk: false, storefrontStatus: 500 }),
    );
    expect(result).toMatchObject({ ok: false, stage: "storefront" });
  });

  it("reports ok:false stage:'exchange' when the OAuth exchange refuses (e.g. a bad/reused code)", async () => {
    const fetchFn = (async (url: string) => {
      if (String(url).includes("/admin/oauth/access_token")) return jsonResponse({}, { ok: false, status: 401 });
      throw new Error("should not reach the delegate/storefront calls after an exchange refusal");
    }) as unknown as typeof globalThis.fetch;
    const result = await runShopifyVerify({ shopDomain: SHOP, code: "bad-code", clientId: "client-id", clientSecret: "client-secret" }, fetchFn);
    expect(result).toEqual({ ok: false, stage: "exchange" });
  });

  it("NEVER returns or echoes a token, on success or on failure", async () => {
    const ok = await runShopifyVerify(
      { shopDomain: SHOP, code: "one-time-code", clientId: "client-id", clientSecret: "client-secret" },
      routedFetch({}),
    );
    const fail = await runShopifyVerify(
      { shopDomain: SHOP, code: "one-time-code", clientId: "client-id", clientSecret: "client-secret" },
      routedFetch({ storefrontOk: false }),
    );
    for (const result of [ok, fail]) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(PARENT_TOKEN);
      expect(serialized).not.toContain(DELEGATE_TOKEN);
      expect(serialized.toLowerCase()).not.toContain("accesstoken"); // no field named accessToken either
    }
  });
});
