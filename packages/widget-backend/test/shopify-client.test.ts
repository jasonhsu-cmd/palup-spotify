import { describe, it, expect, vi } from "vitest";
import { createShopifyAdminClient } from "../src/shopify-client.js";

const creds = { shopDomain: "demo.myshopify.com", accessToken: "admintok" };

it("rejects a non-*.myshopify.com admin host (SSRF, F4)", async () => {
  const c = createShopifyAdminClient({ fetchFn: vi.fn(), creds: { ...creds, shopDomain: "evil.example.com" } });
  await expect(c.graphql("{ shop { name } }")).rejects.toThrow(/myshopify\.com/);
});

it("backs off then retries on THROTTLED (rate limit)", async () => {
  const fetchFn = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ extensions: { code: "THROTTLED" } }],
      extensions: { cost: { throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 0, restoreRate: 100 } } } }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: { shop: { name: "Demo" } } }), { status: 200 }));
  const c = createShopifyAdminClient({ fetchFn, creds, sleep: async () => {} });
  const r = await c.graphql("{ shop { name } }");
  expect(fetchFn).toHaveBeenCalledTimes(2);
  expect(r.data.shop.name).toBe("Demo");
});

it("gives up with a typed error after the attempt cap (no infinite loop)", async () => {
  const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ errors: [{ extensions: { code: "THROTTLED" } }] }), { status: 200 }));
  const c = createShopifyAdminClient({ fetchFn, creds, sleep: async () => {}, maxAttempts: 3 });
  await expect(c.graphql("{ shop { name } }")).rejects.toThrow(/throttl/i);
  expect(fetchFn).toHaveBeenCalledTimes(3);
});

it("downloadJsonl rejects a non-allowlisted result host and never sends the admin token", async () => {
  const fetchFn = vi.fn();
  const c = createShopifyAdminClient({ fetchFn, creds });
  await expect(c.downloadJsonl("https://evil.example.com/x.jsonl")).rejects.toThrow(/host/i);
  const okFetch = vi.fn().mockResolvedValue(new Response("{}\n", { status: 200 }));
  const c2 = createShopifyAdminClient({ fetchFn: okFetch, creds });
  await c2.downloadJsonl("https://storage.googleapis.com/bucket/x.jsonl");
  const headers = (okFetch.mock.calls[0][1]?.headers ?? {}) as Record<string, string>;
  expect(JSON.stringify(headers)).not.toContain("admintok"); // F4: no token on pre-signed download
});
