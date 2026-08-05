import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore, createCachingGroundingPort } from "@palup/platform-ports";
import {
  createShopifyGroundingAdapter,
  storefrontFetch,
  DEFAULT_PAGE_TIMEOUT_MS,
  MAX_CATALOG_PAGES,
  MAX_CATALOG_PRODUCTS,
  STOREFRONT_API_VERSION,
  STOREFRONT_PAGE_SIZE,
  type StorefrontEgressLog,
} from "../src/shopify-grounding.js";

// Cursor pagination over the Storefront `products` connection.
//
// PRIMARY-SOURCE field verification (not memory) — shopify.dev, Storefront API **2026-07** (the version
// STOREFRONT_API_VERSION pins; the page's own version picker marks 2026-07 as "latest", which is why the
// 2026-07 URL resolves to /latest/), all retrieved **2026-08-05**:
//   • https://shopify.dev/docs/api/storefront/2026-07/connections/productconnection
//     Arguments: `first • Int`, `after • String` ("Returns the elements that come after the specified
//     cursor."). Possible returns: `edges ([ProductEdge!]!)`, `nodes ([Product!]!)`, `pageInfo (PageInfo!)`.
//     `sortKey • Product Sort Keys  Default: ID`.
//   • https://shopify.dev/docs/api/storefront/2026-07/objects/PageInfo
//     `hasNextPage (Boolean!)` — "Whether there are more pages to fetch following the current page.";
//     `endCursor (String)` — "The cursor corresponding to the last node in edges."
//   • https://shopify.dev/docs/api/usage/pagination-graphql
//     "You can retrieve up to a maximum of 250 resources." and, for forward pagination, "`after` … the
//     cursor to retrieve nodes after in the connection. Typically, you should pass the endCursor of the
//     previous page as after."
// NO LIVE SHOPIFY CALL was made for this work (no credentials in this environment). The adapter's
// pre-existing live verification (2026-07-31) covers the single-page query only; pagination is
// fixture-tested here against an injected fetch and is NOT live-verified.

const creds = { shopDomain: "acme.myshopify.com", accessToken: "shptok_secret" };
const SHOP = { name: "Acme Skincare", refundPolicy: { body: "30-day returns." }, shippingPolicy: { body: "Free US shipping." } };

const prod = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Product ${id}`,
  description: "d",
  priceRange: { minVariantPrice: { amount: "10.00", currencyCode: "USD" } },
  ...over,
});

interface PageSpec {
  nodes?: Array<Record<string, unknown>>;
  hasNextPage?: boolean;
  endCursor?: string | null;
  /** Omit `pageInfo` entirely (an older/sparser response, or a field the query didn't ask for). */
  omitPageInfo?: boolean;
  /** HTTP-level failure for this page. */
  ok?: boolean;
  status?: number;
  /** GraphQL `errors` payload for this page. */
  errors?: Array<{ message?: string }>;
}

interface RecordedCall {
  url: string;
  query: string;
  variables: { first?: number; after?: string | null };
  headers: Record<string, string>;
  signal: unknown;
}

/**
 * A scripted Storefront endpoint. Serves `pages` in request order and repeats the LAST spec for any
 * further request, so a loop that fails to stop is caught by the assertions rather than by hanging;
 * a >50-request runaway throws outright so a regression can never wedge the suite.
 */
function fakeStorefront(pages: PageSpec[]) {
  const calls: RecordedCall[] = [];
  const fn = (async (url: string, init: { body: string; headers: Record<string, string>; signal: unknown }) => {
    const body = JSON.parse(init.body) as { query: string; variables: { first?: number; after?: string | null } };
    calls.push({ url, query: body.query, variables: body.variables, headers: init.headers, signal: init.signal });
    if (calls.length > 50) throw new Error("runaway pagination: >50 Storefront requests");
    const spec = pages[Math.min(calls.length - 1, pages.length - 1)] as PageSpec;
    const products: Record<string, unknown> = { nodes: spec.nodes ?? [] };
    if (!spec.omitPageInfo) products.pageInfo = { hasNextPage: spec.hasNextPage ?? false, endCursor: spec.endCursor ?? null };
    return {
      ok: spec.ok ?? true,
      status: spec.status ?? 200,
      json: async () => (spec.errors ? { errors: spec.errors } : { data: { shop: SHOP, products } }),
    } as Response;
  }) as unknown as typeof globalThis.fetch;
  return { fn, calls };
}

/**
 * A store that NEVER ends and whose cursor ALWAYS advances: every response says hasNextPage:true with a
 * fresh cursor. Nothing but the page ceiling can stop a loop here (the cursor-stall guard cannot), so this
 * is the shape that isolates the ceiling. The >50 guard turns a lost ceiling into a failed test instead of
 * a hung suite.
 */
function neverEndingStorefront() {
  const calls: RecordedCall[] = [];
  const fn = (async (url: string, init: { body: string; headers: Record<string, string>; signal: unknown }) => {
    const body = JSON.parse(init.body) as { query: string; variables: { first?: number; after?: string | null } };
    calls.push({ url, query: body.query, variables: body.variables, headers: init.headers, signal: init.signal });
    if (calls.length > 50) throw new Error("runaway pagination: >50 Storefront requests");
    const n = calls.length;
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { shop: SHOP, products: { nodes: [prod(`p${n}`)], pageInfo: { hasNextPage: true, endCursor: `cursor-${n}` } } } }),
    } as Response;
  }) as unknown as typeof globalThis.fetch;
  return { fn, calls };
}

function collectLogs() {
  const logs: StorefrontEgressLog[] = [];
  return { logs, log: (i: StorefrontEgressLog) => logs.push(i) };
}

describe("storefrontFetch pagination — the catalog is fetched WHOLE or not at all", () => {
  it("fetches a single-page catalog in ONE request, asking for products AFTER no cursor", async () => {
    const { fn, calls } = fakeStorefront([{ nodes: [prod("1"), prod("2")], hasNextPage: false, endCursor: "c1" }]);
    const data = await storefrontFetch(fn)(creds);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://acme.myshopify.com/api/${STOREFRONT_API_VERSION}/graphql.json`);
    expect(calls[0]!.variables.first).toBe(STOREFRONT_PAGE_SIZE);
    expect(calls[0]!.variables.after ?? null).toBeNull(); // first page starts at the beginning of the list
    expect(data.products?.nodes?.map((n) => n.id)).toEqual(["1", "2"]);
    expect(data.shop?.name).toBe("Acme Skincare");
  });

  it("treats a response with NO pageInfo as complete — never a blind second request", async () => {
    const { fn, calls } = fakeStorefront([{ nodes: [prod("1")], omitPageInfo: true }]);
    const data = await storefrontFetch(fn)(creds);
    expect(calls).toHaveLength(1);
    expect(data.products?.nodes).toHaveLength(1);
  });

  it("stops at exactly one page when a FULL page reports hasNextPage:false (boundary, not truncation)", async () => {
    const full = Array.from({ length: STOREFRONT_PAGE_SIZE }, (_, i) => prod(String(i)));
    const { fn, calls } = fakeStorefront([{ nodes: full, hasNextPage: false, endCursor: "c1" }]);
    const data = await storefrontFetch(fn)(creds);
    expect(calls).toHaveLength(1);
    expect(data.products?.nodes).toHaveLength(STOREFRONT_PAGE_SIZE);
  });

  it("follows a FULL page that reports hasNextPage:true — a page boundary is not mistaken for the end", async () => {
    const full = Array.from({ length: STOREFRONT_PAGE_SIZE }, (_, i) => prod(String(i)));
    const { fn, calls } = fakeStorefront([
      { nodes: full, hasNextPage: true, endCursor: "cursor-250" },
      { nodes: [prod("a"), prod("b"), prod("c")], hasNextPage: false },
    ]);
    const data = await storefrontFetch(fn)(creds);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.variables.after).toBe("cursor-250"); // endCursor of the previous page, per the docs
    expect(data.products?.nodes).toHaveLength(STOREFRONT_PAGE_SIZE + 3);
    expect(data.products?.nodes?.at(-1)?.id).toBe("c");
  });

  it("assembles every page IN ORDER, threading each endCursor into the next `after`", async () => {
    const { fn, calls } = fakeStorefront([
      { nodes: [prod("1"), prod("2")], hasNextPage: true, endCursor: "c1" },
      { nodes: [prod("3"), prod("4")], hasNextPage: true, endCursor: "c2" },
      { nodes: [prod("5")], hasNextPage: false, endCursor: "c3" },
    ]);
    const data = await storefrontFetch(fn)(creds);
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.variables.after ?? null)).toEqual([null, "c1", "c2"]);
    expect(data.products?.nodes?.map((n) => n.id)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("asks for the shop/policy block ONCE (page 1 only) — bounded work per additional page", async () => {
    const { fn, calls } = fakeStorefront([
      { nodes: [prod("1")], hasNextPage: true, endCursor: "c1" },
      { nodes: [prod("2")], hasNextPage: false },
    ]);
    const data = await storefrontFetch(fn)(creds);
    expect(calls[0]!.query).toContain("refundPolicy { body }");
    expect(calls[1]!.query).not.toContain("refundPolicy");
    expect(calls[1]!.query).not.toContain("shippingPolicy");
    for (const c of calls) {
      expect(c.query).toContain("products(first: $first, after: $after)");
      expect(c.query).toContain("pageInfo { hasNextPage endCursor }");
    }
    expect(data.shop?.name).toBe("Acme Skincare"); // still carried, from page 1
  });

  it("sends the private token header and a per-request timeout signal on EVERY page", async () => {
    const { fn, calls } = fakeStorefront([
      { nodes: [prod("1")], hasNextPage: true, endCursor: "c1" },
      { nodes: [prod("2")], hasNextPage: true, endCursor: "c2" },
      { nodes: [prod("3")], hasNextPage: false },
    ]);
    await storefrontFetch(fn)(creds);
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.headers["Shopify-Storefront-Private-Token"]).toBe("shptok_secret");
      expect(c.headers["X-Shopify-Storefront-Access-Token"]).toBeUndefined(); // never the public browser header
      expect(c.signal).toBeInstanceOf(AbortSignal); // AbortSignal.timeout per page — no page can hang
    }
  });
});

describe("the catalog ceiling — a catalog too big to serve FAILS LOUDLY, it never truncates", () => {
  it("pins the ceiling so raising it must be a deliberate, reviewed edit", () => {
    expect(STOREFRONT_PAGE_SIZE).toBe(250); // Storefront max page size (docs cite above)
    expect(MAX_CATALOG_PAGES).toBe(4);
    expect(MAX_CATALOG_PRODUCTS).toBe(1000);
    expect(MAX_CATALOG_PRODUCTS).toBe(STOREFRONT_PAGE_SIZE * MAX_CATALOG_PAGES);
  });

  it("bounds worst-case total latency at pages x the per-page timeout", () => {
    expect(DEFAULT_PAGE_TIMEOUT_MS).toBe(4000);
    expect(MAX_CATALOG_PAGES * DEFAULT_PAGE_TIMEOUT_MS).toBe(16_000); // the stated worst case
  });

  it("HARD-FAILS at the default page ceiling instead of returning a truncated catalog", async () => {
    // Cursors keep advancing, so ONLY the ceiling can end this — and it must, at exactly MAX_CATALOG_PAGES.
    const { fn, calls } = neverEndingStorefront();
    await expect(storefrontFetch(fn)(creds)).rejects.toThrow(/catalog exceeds the supported size/);
    expect(calls).toHaveLength(MAX_CATALOG_PAGES); // never a page beyond the ceiling
  });

  it("reports the ceiling breach with the ADVANCING-cursor shape too (the real oversized-store case)", async () => {
    const { logs, log } = collectLogs();
    const { fn } = neverEndingStorefront();
    await expect(storefrontFetch(fn, { log })(creds)).rejects.toThrow(/catalog exceeds the supported size/);
    expect(logs.filter((l) => l.reason === "catalog-ceiling-exceeded")).toHaveLength(1);
    expect(logs.find((l) => l.reason === "catalog-ceiling-exceeded")!.maxPages).toBe(MAX_CATALOG_PAGES);
  });

  it("succeeds for a catalog sitting exactly ON the ceiling", async () => {
    const { fn, calls } = fakeStorefront([
      { nodes: [prod("1")], hasNextPage: true, endCursor: "c1" },
      { nodes: [prod("2")], hasNextPage: true, endCursor: "c2" },
      { nodes: [prod("3")], hasNextPage: false, endCursor: "c3" },
    ]);
    const data = await storefrontFetch(fn, { maxPages: 3 })(creds);
    expect(calls).toHaveLength(3);
    expect(data.products?.nodes?.map((n) => n.id)).toEqual(["1", "2", "3"]);
  });

  it("REPORTS the breach on the structured egress log (observable, and never the token)", async () => {
    const { logs, log } = collectLogs();
    const { fn } = fakeStorefront([{ nodes: [prod("a"), prod("b")], hasNextPage: true, endCursor: "c1" }]);
    await expect(storefrontFetch(fn, { maxPages: 2, log })(creds)).rejects.toThrow();
    const breach = logs.find((l) => l.reason === "catalog-ceiling-exceeded");
    expect(breach, `no ceiling breach line in ${JSON.stringify(logs)}`).toBeDefined();
    expect(breach!.host).toBe("acme.myshopify.com");
    expect(breach!.ok).toBe(false);
    expect(breach!.products).toBe(4); // the partial count we are DISCARDING, not serving
    expect(breach!.maxPages).toBe(2);
    expect(typeof breach!.ms).toBe("number");
    expect(JSON.stringify(logs)).not.toContain("shptok_secret");
  });

  it("logs one line per page, numbered, with that page's node count", async () => {
    const { logs, log } = collectLogs();
    const { fn } = fakeStorefront([
      { nodes: [prod("1"), prod("2")], hasNextPage: true, endCursor: "c1" },
      { nodes: [prod("3")], hasNextPage: false },
    ]);
    await storefrontFetch(fn, { log })(creds);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ host: "acme.myshopify.com", status: 200, ok: true, page: 1, nodes: 2 });
    expect(logs[1]).toMatchObject({ page: 2, nodes: 1, ok: true });
  });
});

describe("a partial fetch is never passed off as a small catalog", () => {
  it("THROWS when a later page fails — pages already fetched are discarded, not returned", async () => {
    const { fn, calls } = fakeStorefront([
      { nodes: [prod("1"), prod("2")], hasNextPage: true, endCursor: "c1" },
      { nodes: [prod("3")], hasNextPage: true, endCursor: "c2" },
      { ok: false, status: 500 },
    ]);
    await expect(storefrontFetch(fn)(creds)).rejects.toThrow(/request failed/);
    expect(calls).toHaveLength(3);
  });

  it("reports the discarded partial on the egress log (the previously invisible event)", async () => {
    const { logs, log } = collectLogs();
    const { fn } = fakeStorefront([
      { nodes: [prod("1"), prod("2")], hasNextPage: true, endCursor: "c1" },
      { ok: false, status: 503 },
    ]);
    await expect(storefrontFetch(fn, { log })(creds)).rejects.toThrow();
    const discarded = logs.find((l) => l.reason === "pagination-discarded-partial");
    expect(discarded, `no discarded-partial line in ${JSON.stringify(logs)}`).toBeDefined();
    expect(discarded!.products).toBe(2);
    expect(logs.some((l) => l.status === 503 && l.ok === false)).toBe(true); // the HTTP line survives too
    expect(JSON.stringify(logs)).not.toContain("shptok_secret");
  });

  it("throws the STATIC message on a GraphQL error payload from a LATER page (no vendor text)", async () => {
    const { fn } = fakeStorefront([
      { nodes: [prod("1")], hasNextPage: true, endCursor: "c1" },
      { errors: [{ message: "sensitive vendor detail" }] },
    ]);
    const err = await storefrontFetch(fn)(creds).catch((e) => e as Error);
    expect(err.message).toBe("Shopify Storefront GraphQL error");
    expect(err.message).not.toContain("sensitive vendor detail");
  });

  it("keeps the caching wrapper's LAST-KNOWN-GOOD when a later page fails (stale beats truncated)", async () => {
    // The contract this adapter degrades through: throw => stale-while-error, cold-throw => safe-empty.
    let broken = false;
    const script: PageSpec[] = [
      { nodes: [prod("1"), prod("2")], hasNextPage: true, endCursor: "c1" },
      { nodes: [prod("3")], hasNextPage: false },
    ];
    const fn = (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { variables: { after?: string | null } };
      const isFirstPage = (body.variables.after ?? null) === null;
      if (!isFirstPage && broken) return { ok: false, status: 500, json: async () => ({}) } as Response;
      const spec = (isFirstPage ? script[0] : script[1]) as PageSpec;
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { shop: SHOP, products: { nodes: spec.nodes, pageInfo: { hasNextPage: spec.hasNextPage ?? false, endCursor: spec.endCursor ?? null } } } }),
      } as Response;
    }) as unknown as typeof globalThis.fetch;

    const inner = createShopifyGroundingAdapter(creds, storefrontFetch(fn));
    const cached = createCachingGroundingPort(inner, new InMemoryRuntimeStore(), { ttlSeconds: 0 });
    const whole = await cached.getContext("acme");
    expect(whole.products.map((p) => p.id)).toEqual(["1", "2", "3"]);
    await new Promise((r) => setTimeout(r, 0)); // the cache write is fire-and-forget

    broken = true;
    const after = await cached.getContext("acme");
    // NOT ["1","2"] — a partial page-1-only catalog must never be cached or served as the whole store.
    expect(after.products.map((p) => p.id)).toEqual(["1", "2", "3"]);
  });

  it("fails CLOSED to safe-empty when a later page fails with a COLD cache", async () => {
    const { fn } = fakeStorefront([
      { nodes: [prod("1"), prod("2")], hasNextPage: true, endCursor: "c1" },
      { ok: false, status: 500 },
    ]);
    const inner = createShopifyGroundingAdapter(creds, storefrontFetch(fn));
    const cached = createCachingGroundingPort(inner, new InMemoryRuntimeStore());
    const ctx = await cached.getContext("acme");
    expect(ctx.products).toEqual([]); // safe-empty: "I can't find products" beats "we don't carry that"
  });
});

describe("a broken cursor can never become an infinite loop or a silent restart", () => {
  it("hard-fails when hasNextPage is true but endCursor is null", async () => {
    const { logs, log } = collectLogs();
    const { fn, calls } = fakeStorefront([{ nodes: [prod("1")], hasNextPage: true, endCursor: null }]);
    await expect(storefrontFetch(fn, { log })(creds)).rejects.toThrow(/cursor/i);
    expect(calls).toHaveLength(1); // never a second request without a valid cursor
    expect(logs.some((l) => l.reason === "pagination-cursor-missing")).toBe(true);
  });

  it("hard-fails when endCursor is an empty string", async () => {
    const { fn } = fakeStorefront([{ nodes: [prod("1")], hasNextPage: true, endCursor: "" }]);
    await expect(storefrontFetch(fn)(creds)).rejects.toThrow(/cursor/i);
  });

  it("hard-fails when pageInfo omits endCursor entirely", async () => {
    const calls: string[] = [];
    const fn = (async (_url: string, init: { body: string }) => {
      calls.push(init.body);
      return { ok: true, status: 200, json: async () => ({ data: { shop: SHOP, products: { nodes: [prod("1")], pageInfo: { hasNextPage: true } } } }) } as Response;
    }) as unknown as typeof globalThis.fetch;
    await expect(storefrontFetch(fn)(creds)).rejects.toThrow(/cursor/i);
    expect(calls).toHaveLength(1);
  });

  it("hard-fails when the cursor does NOT ADVANCE (the store keeps handing back the same page)", async () => {
    const { logs, log } = collectLogs();
    // Every response carries the SAME endCursor — the shape a re-fetching loop would spin on forever.
    const { fn, calls } = fakeStorefront([{ nodes: [prod("1")], hasNextPage: true, endCursor: "stuck" }]);
    await expect(storefrontFetch(fn, { maxPages: 20, log })(creds)).rejects.toThrow(/did not advance/);
    expect(calls).toHaveLength(2); // detected on the FIRST repeat, long before the page ceiling
    expect(logs.some((l) => l.reason === "pagination-cursor-stalled")).toBe(true);
  });
});

describe("the existing bounds and sanitization apply to EVERY page, not just the first", () => {
  it("bounds title/description/tags on a product that arrived on page 2", async () => {
    const { fn } = fakeStorefront([
      { nodes: [prod("1")], hasNextPage: true, endCursor: "c1" },
      {
        nodes: [prod("2", { title: "T".repeat(500), description: "D".repeat(2000), tags: Array.from({ length: 50 }, (_, i) => `t${i}`) })],
        hasNextPage: false,
      },
    ]);
    const ctx = await createShopifyGroundingAdapter(creds, storefrontFetch(fn)).getContext("acme");
    expect(ctx.products).toHaveLength(2);
    const late = ctx.products[1]!;
    expect(late.title.length).toBe(200);
    expect(late.description.length).toBe(600);
    expect(late.tags!.length).toBe(20);
  });

  it("keeps three-state availability per product across pages", async () => {
    const { fn } = fakeStorefront([
      { nodes: [prod("1", { availableForSale: true })], hasNextPage: true, endCursor: "c1" },
      { nodes: [prod("2", { availableForSale: false }), prod("3")], hasNextPage: false },
    ]);
    const ctx = await createShopifyGroundingAdapter(creds, storefrontFetch(fn)).getContext("acme");
    expect(ctx.products.map((p) => p.availableForSale)).toEqual([true, false, undefined]);
  });

  it("stamps the REQUESTED tenant on a multi-page context", async () => {
    const { fn } = fakeStorefront([
      { nodes: [prod("1")], hasNextPage: true, endCursor: "c1" },
      { nodes: [prod("2")], hasNextPage: false },
    ]);
    const ctx = await createShopifyGroundingAdapter(creds, storefrontFetch(fn)).getContext("acme");
    expect(ctx.tenantId).toBe("acme");
    expect(ctx.products).toHaveLength(2);
  });

  it("still refuses a non-*.myshopify.com host before any page is requested", async () => {
    const { fn, calls } = fakeStorefront([{ nodes: [prod("1")], hasNextPage: true, endCursor: "c1" }]);
    await expect(storefrontFetch(fn)({ shopDomain: "evil.com", accessToken: "shptok_secret" })).rejects.toThrow(/myshopify\.com/);
    expect(calls).toHaveLength(0);
  });
});
