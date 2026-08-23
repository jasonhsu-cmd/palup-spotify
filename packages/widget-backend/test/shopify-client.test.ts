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

// ── runBulkQuery / pollBulk — the module's OWN parsing/branching logic ─────────────────────────────
// These fixtures assume a `bulkOperationRunQuery { bulkOperation { id status } userErrors { field
// message } }` mutation shape and a `node(id:) { ... on BulkOperation { id status errorCode
// objectCount url partialDataUrl } }` poll shape (matching what shopify-client.ts sends). The field
// names/paths themselves are NOT asserted to be live-Shopify-correct here — that wire-shape
// verification stays deferred to a live bulk run (spec §13.3, see the file-level "NOT LIVE-VERIFIED"
// comment in shopify-client.ts). These tests only exercise how THIS module parses/branches on a
// response already shaped that way.

it("runBulkQuery throws a typed error when the response carries userErrors", async () => {
  const fetchFn = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({ data: { bulkOperationRunQuery: { bulkOperation: null, userErrors: [{ field: ["query"], message: "bad query" }] } } }),
      { status: 200 },
    ),
  );
  const c = createShopifyAdminClient({ fetchFn, creds });
  await expect(c.runBulkQuery("{ products { edges { node { id } } } }")).rejects.toThrow(/userErrors|error/i);
});

it("runBulkQuery returns the bulk operation id on a clean response", async () => {
  const fetchFn = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        data: { bulkOperationRunQuery: { bulkOperation: { id: "gid://shopify/BulkOperation/123", status: "CREATED" }, userErrors: [] } },
      }),
      { status: 200 },
    ),
  );
  const c = createShopifyAdminClient({ fetchFn, creds });
  const r = await c.runBulkQuery("{ products { edges { node { id } } } }");
  expect(r).toEqual({ id: "gid://shopify/BulkOperation/123" });
});

it("pollBulk coerces a string objectCount to a number", async () => {
  const fetchFn = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({ data: { node: { id: "gid://shopify/BulkOperation/123", status: "COMPLETED", objectCount: "42", url: "https://storage.googleapis.com/x.jsonl" } } }),
      { status: 200 },
    ),
  );
  const c = createShopifyAdminClient({ fetchFn, creds });
  const r = await c.pollBulk("gid://shopify/BulkOperation/123");
  expect(r.objectCount).toBe(42);
  expect(typeof r.objectCount).toBe("number");
});

it("pollBulk prefers `url` over `partialDataUrl` when both are present, and falls back to `partialDataUrl` when `url` is absent", async () => {
  const bothFetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({ data: { node: { status: "COMPLETED", url: "https://storage.googleapis.com/full.jsonl", partialDataUrl: "https://storage.googleapis.com/partial.jsonl" } } }),
      { status: 200 },
    ),
  );
  const cBoth = createShopifyAdminClient({ fetchFn: bothFetch, creds });
  expect((await cBoth.pollBulk("id")).url).toBe("https://storage.googleapis.com/full.jsonl");

  const partialOnlyFetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ data: { node: { status: "RUNNING", partialDataUrl: "https://storage.googleapis.com/partial.jsonl" } } }), { status: 200 }),
  );
  const cPartial = createShopifyAdminClient({ fetchFn: partialOnlyFetch, creds });
  expect((await cPartial.pollBulk("id")).url).toBe("https://storage.googleapis.com/partial.jsonl");
});

it("pollBulk maps the status field through for both a running and a completed operation", async () => {
  const runningFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { node: { status: "RUNNING" } } }), { status: 200 }));
  const cRunning = createShopifyAdminClient({ fetchFn: runningFetch, creds });
  expect((await cRunning.pollBulk("id")).status).toBe("RUNNING");

  const completedFetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ data: { node: { status: "COMPLETED", objectCount: "7", url: "https://storage.googleapis.com/done.jsonl" } } }), { status: 200 }),
  );
  const cCompleted = createShopifyAdminClient({ fetchFn: completedFetch, creds });
  const completed = await cCompleted.pollBulk("id");
  expect(completed.status).toBe("COMPLETED");
  expect(completed.objectCount).toBe(7);
  expect(completed.url).toBe("https://storage.googleapis.com/done.jsonl");
});
