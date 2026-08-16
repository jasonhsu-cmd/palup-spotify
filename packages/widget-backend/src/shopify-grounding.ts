import type { GroundingContext, GroundingPort, GroundingShell, Product, StorePolicy } from "@palup/platform-ports";
import type { ShopifyStoreCreds } from "./merchant-store.js";

// Shopify GroundingPort adapter (ADR-0012). Maps a merchant's Shopify **Storefront API** data onto the
// vendor-neutral GroundingContext, entirely behind GroundingPort (NN#3 — no Shopify types cross the
// port). Chosen over the Admin API for least-privilege (published storefront data only, no
// inventory/cost/PII).
//
// The GraphQL query + response shape below were VERIFIED against the Shopify Storefront API docs
// (version 2026-07, shopify.dev, retrieved 2026-07-30): products(first:){nodes{id,title,description,
// tags,priceRange{minVariantPrice{amount,currencyCode}}}} and shop{name,refundPolicy{body},
// shippingPolicy{body}} (ShopPolicy.body is String!). PalUp calls the Storefront API SERVER-SIDE, so
// it authenticates with a PRIVATE (delegate) Storefront access token via the `Shopify-Storefront-
// Private-Token` header (kept secret in the SecretsPort — not the public `X-Shopify-Storefront-Access-
// Token` browser header). The pure mapping is fixture-tested; the LIVE end-to-end call (auth + real
// response) was VERIFIED 2026-07-31 against the real store `palup-skincare-jason.myshopify.com` (HTTP 200;
// brand + refund/shipping policies + a real catalog returned) with the private token in Secret Manager
// `palup-secrets`. It is wired into the deployed service via `SHOPIFY_STORES` + `PALUP_SECRETS` in
// deploy-staging.yml (both REPLACE-set every deploy — see the note there). That live check covers the
// SINGLE-PAGE query; the cursor pagination added later (see the citation block above STOREFRONT_PAGE_SIZE,
// docs retrieved 2026-08-05) is fixture-tested only and has NOT been exercised against a live store.

/** Storefront product node (Storefront API 2026-07). */
export interface StorefrontProductNode {
  id: string;
  title: string;
  description?: string;
  tags?: string[];
  priceRange?: { minVariantPrice?: { amount?: string; currencyCode?: string } };
  /** `Product.availableForSale: Boolean!` — see the GroundingPort field for why not `quantityAvailable`. */
  availableForSale?: boolean;
  /** C1 — the first variant's node, for the one-tap cart permalink id. `variants(first: 1) { nodes { id } }`. */
  variants?: { nodes?: { id?: string }[] };
}

/**
 * Relay `PageInfo` on the `products` connection (Storefront API 2026-07). Both fields are quoted from
 * primary docs in the STOREFRONT_QUERY citation below. Typed OPTIONAL/nullable even though `hasNextPage`
 * is `Boolean!` in the schema, because this shape also describes responses this adapter did not author
 * (fixtures, a test double, a future API version that drops a field) — and a missing `hasNextPage` must
 * read as "no more pages", never as "keep fetching".
 */
export interface StorefrontPageInfo {
  hasNextPage?: boolean;
  endCursor?: string | null;
}

/** Storefront query response (the fields this adapter requests). */
export interface StorefrontData {
  shop?: {
    name?: string;
    refundPolicy?: { body?: string };
    shippingPolicy?: { body?: string };
  };
  products?: { nodes?: StorefrontProductNode[]; pageInfo?: StorefrontPageInfo };
}

// Bounds on merchant-supplied catalog text before it flows into the system prompt: caps prompt bloat and
// limits the prompt-injection surface of merchant-authored fields (a merchant can only affect its OWN
// tenant's agent — not cross-tenant — but bounding is prudent; deeper sanitization is a follow-up).
const MAX_TITLE = 200;
const MAX_DESC = 600;
const MAX_TAGS = 20;
const bound = (s: string | undefined, max: number): string => (s ?? "").slice(0, max);

function formatPrice(p?: { amount?: string; currencyCode?: string }): string {
  if (!p?.amount) return "";
  return p.currencyCode && p.currencyCode !== "USD" ? `${p.amount} ${p.currencyCode}` : `$${p.amount}`;
}

/**
 * Pure mapping: Storefront response → GroundingContext. Stamps the REQUESTED tenantId (never a value
 * from the response), so a mis-scoped fetch can't smuggle another tenant's id past the cache's
 * tenant-match assertion. Bounds merchant text. Tested against synthetic fixtures.
 */
// C1 — the numeric Shopify variant id for a one-tap cart permalink, from the first variant's GID
// (gid://shopify/ProductVariant/4567 -> "4567"), else undefined. Shopify-specific extraction stays in THIS
// adapter; only the opaque neutral `Product.variantId` crosses the port (the widget builds the cart URL).
// NOT LIVE-VERIFIED: `variants(first:1){nodes{id}}` was added to the query after the 2026-07-31 live check
// (like the pagination fields), so it is mock-tested here — confirm against the live Storefront API
// (drift-check / model:smoke) before relying on it.
function firstVariantNumericId(node: StorefrontProductNode): string | undefined {
  const gid = node.variants?.nodes?.[0]?.id;
  if (typeof gid !== "string") return undefined;
  const m = gid.match(/\/ProductVariant\/(\d{1,20})$/);
  if (m) return m[1];
  return /^\d{1,20}$/.test(gid) ? gid : undefined;
}

export function mapStorefrontToContext(tenantId: string, data: StorefrontData): GroundingContext {
  const products: Product[] = (data.products?.nodes ?? []).map((n) => ({
    id: n.id,
    title: bound(n.title, MAX_TITLE),
    description: bound(n.description, MAX_DESC),
    price: formatPrice(n.priceRange?.minVariantPrice),
    tags: (n.tags ?? []).slice(0, MAX_TAGS),
    // Only carried when Shopify actually returned a boolean. A missing/non-boolean value stays
    // UNDEFINED rather than collapsing to false, because "unknown" and "not purchasable" are different
    // claims to make to a shopper and the prompt handles them differently.
    availableForSale: typeof n.availableForSale === "boolean" ? n.availableForSale : undefined,
    // C1 — the opaque cart/checkout variant id (undefined when the source reports no variant).
    variantId: firstVariantNumericId(n),
  }));
  const policy: StorePolicy = {
    returns: bound(data.shop?.refundPolicy?.body, MAX_DESC),
    shipping: bound(data.shop?.shippingPolicy?.body, MAX_DESC),
  };
  return { tenantId, brandName: bound(data.shop?.name, MAX_TITLE) || "this store", products, policy };
}

export type StorefrontFetch = (creds: ShopifyStoreCreds) => Promise<StorefrontData>;

/** Shop brand + policy ONLY — no products connection, so this is ALWAYS a single round-trip and can
 *  never approach the catalog page ceiling. */
const STOREFRONT_SHELL_QUERY = `query PalUpGroundingShell {
  shop { name refundPolicy { body } shippingPolicy { body } }
}`;

export type StorefrontShellFetch = (creds: ShopifyStoreCreds) => Promise<StorefrontData>;

/** Pure mapping: shell response → GroundingShell. Stamps the REQUESTED tenantId, bounds merchant text. */
export function mapStorefrontToShell(tenantId: string, data: StorefrontData): GroundingShell {
  const policy: StorePolicy = {
    returns: bound(data.shop?.refundPolicy?.body, MAX_DESC),
    shipping: bound(data.shop?.shippingPolicy?.body, MAX_DESC),
  };
  return { tenantId, brandName: bound(data.shop?.name, MAX_TITLE) || "this store", policy };
}

/** Current Storefront API version (verified 2026-07-30 against shopify.dev). */
export const STOREFRONT_API_VERSION = "2026-07";

// The Storefront token is sent in a header to `shopDomain`, so refuse any host that isn't a Shopify
// store host — a misconfigured/typo'd domain must never leak the token to an arbitrary server (SSRF /
// credential-exfil defense-in-depth). shopDomain is operator config (not client), so this guards
// operator error. Custom storefront domains would need an explicit allowlist — a follow-up.
const SHOP_HOST = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

// ── Cursor pagination over the `products` connection ────────────────────────────────────────────────
//
// The connection fields below were VERIFIED against PRIMARY DOCS (shopify.dev, Storefront API **2026-07**
// — the version STOREFRONT_API_VERSION pins; that page's own version picker marks 2026-07 as "latest",
// which is why the 2026-07 URL resolves to /latest/), all retrieved **2026-08-05**:
//   • .../api/storefront/2026-07/connections/productconnection
//       arguments  `first • Int`, `after • String` — "Returns the elements that come after the specified
//                  cursor."; `sortKey • Product Sort Keys  Default: ID`
//       returns    `nodes ([Product!]!)`, `pageInfo (PageInfo!)`, `edges ([ProductEdge!]!)`
//   • .../api/storefront/2026-07/objects/PageInfo
//       `hasNextPage (Boolean!)` — "Whether there are more pages to fetch following the current page."
//       `endCursor (String)`     — "The cursor corresponding to the last node in edges."
//   • .../api/usage/pagination-graphql
//       "You can retrieve up to a maximum of 250 resources." and, for forward pagination, "`after` … the
//       cursor to retrieve nodes after in the connection. Typically, you should pass the endCursor of the
//       previous page as after."
// We request `nodes` + `pageInfo` (not `edges { cursor }`): the pagination guide's own example pairs
// `nodes` with `pageInfo`, and `endCursor` is exactly the per-page cursor we need.
//
// NOT LIVE-VERIFIED: the file-level 2026-07-31 live check covers the single-page query only. The
// pagination change is fixture-tested against an injected fetch (test/shopify-grounding-pagination.test.ts);
// no live Shopify call was made for it.

/** Storefront max page size — "You can retrieve up to a maximum of 250 resources." (docs cite above). */
export const STOREFRONT_PAGE_SIZE = 250;

/**
 * HARD page ceiling: at most this many Storefront round-trips per catalog fetch. Crossing it does NOT
 * truncate — it THROWS (see the ceiling note on storefrontFetch). Also bounds worst-case latency at
 * MAX_CATALOG_PAGES × DEFAULT_PAGE_TIMEOUT_MS.
 */
export const MAX_CATALOG_PAGES = 4;

/**
 * The INDEX job's page ceiling — deep enough to page the whole `MAX_INDEXED_PRODUCTS` (50000 / 250 = 200
 * pages). SEPARATE from `MAX_CATALOG_PAGES` (serving's per-turn cap, still 4): the offline index job pays
 * ~200 sequential round-trips once, the /chat path never does. `getContext` keeps its 4-page cap so serving
 * can never page 50k per turn.
 */
export const MAX_INDEX_CATALOG_PAGES = 200;

/**
 * The catalog size this adapter supports: 4 pages × 250 = 1000 published products.
 *
 * Why 1000 and not more: the binding constraint is the PROMPT, not the network. widget-brain's
 * composeSystemPrompt renders EVERY product in the GroundingContext into the system prompt of EVERY
 * shopper turn, with no count cap (verified: no `products.slice`/`products.length` cap anywhere in
 * widget-brain/src or widget-backend/src). At the per-product bounds this adapter enforces, 1000 products
 * is already a six-figure-character system prompt on every turn — the cost/latency ceiling arrives before
 * this one does. A merchant above 1000 SKUs does not need a bigger fetch; they need relevance retrieval
 * (fetch → index → retrieve top-K) — S2 (`docs/superpowers/specs/2026-08-15-s2-serving-unlock-design.md`)
 * built exactly that path (`catalog-index.ts`'s offline index job + `catalog-retriever.ts` + `brain.ts`'s
 * `retrieveViaShell`), behind `catalogRetrievalEnabled` (dark; enabling it to serve is a separate,
 * still-open HITL §5 promotion). This constant stays the SERVING fetch's cap either way: raising it
 * without retrieval would quietly move the failure from "loud" to "unaffordable".
 */
export const MAX_CATALOG_PRODUCTS = STOREFRONT_PAGE_SIZE * MAX_CATALOG_PAGES;

/** Per-PAGE request timeout. Worst case for a whole fetch = MAX_CATALOG_PAGES × this = 16s. */
export const DEFAULT_PAGE_TIMEOUT_MS = 4000;

/**
 * Why an abnormal pagination outcome is reported on the egress log rather than swallowed: the thrown
 * errors are deliberately static and unlogged (F1), so without this line the difference between "small
 * catalog" and "catalog we refused to serve" would be invisible to operators. Never carries the token.
 */
export type StorefrontEgressReason =
  /** hasNextPage was still true after MAX_CATALOG_PAGES — the catalog is bigger than we can serve. */
  | "catalog-ceiling-exceeded"
  /** hasNextPage true but endCursor absent/empty — we refuse to guess a cursor. */
  | "pagination-cursor-missing"
  /** endCursor did not advance — a re-fetch loop, stopped on the first repeat. */
  | "pagination-cursor-stalled"
  /** A page ≥ 2 failed: the pages already fetched are being DISCARDED, not returned. */
  | "pagination-discarded-partial";

/** Structured egress log line (token-free by construction — the token is never a field here). */
export interface StorefrontEgressLog {
  host: string;
  status: number;
  ok: boolean;
  ms: number;
  /** 1-based page index this line describes (1 for a single-page catalog). */
  page?: number;
  /** Product nodes returned by THIS page; absent when the request failed before a body was parsed. */
  nodes?: number;
  /** Set ONLY on an abnormal pagination outcome. `status: 0` on those lines = a local decision, no HTTP. */
  reason?: StorefrontEgressReason;
  /** Products accumulated (and discarded) when an abnormal outcome fired. */
  products?: number;
  /** The page ceiling in force when it fired. */
  maxPages?: number;
}

const PRODUCT_PAGE_FIELDS = `nodes { id title description tags availableForSale priceRange { minVariantPrice { amount currencyCode } } variants(first: 1) { nodes { id } } }
    pageInfo { hasNextPage endCursor }`;

/** Page 1: shop/policy + the first product page. `$after` is nullable — null means "start of the list". */
const STOREFRONT_QUERY = `query PalUpGrounding($first: Int!, $after: String) {
  shop { name refundPolicy { body } shippingPolicy { body } }
  products(first: $first, after: $after) {
    ${PRODUCT_PAGE_FIELDS}
  }
}`;

/** Pages 2..n: products ONLY. The shop/policy bodies are fetched once, not re-sent per page. */
const STOREFRONT_PAGE_QUERY = `query PalUpGroundingPage($first: Int!, $after: String) {
  products(first: $first, after: $after) {
    ${PRODUCT_PAGE_FIELDS}
  }
}`;

/**
 * The live Storefront GraphQL fetch. POSTs the verified query to
 * `https://{shopDomain}/api/{version}/graphql.json` with the server-side `Shopify-Storefront-Private-Token` header.
 * `fetchFn` is injectable for tests (defaults to global fetch). Throws on a non-2xx response or a GraphQL
 * error so the caching wrapper degrades safely (stale/safe-empty). AbortSignal.timeout cancels the
 * underlying request on timeout (caching-review F3), per page.
 *
 * WHOLE CATALOG OR NOTHING. The catalog is assembled by following `pageInfo.endCursor` into `after` until
 * `hasNextPage` is false, and this function returns ONLY a complete catalog. Every other outcome throws:
 *
 *   • more than MAX_CATALOG_PAGES pages  → throw (the ceiling)
 *   • a page ≥ 2 fails / errors          → throw, discarding what we already have
 *   • hasNextPage true, no usable cursor → throw
 *   • endCursor that doesn't advance     → throw (a re-fetch loop, caught on the first repeat)
 *
 * Why HARD-FAIL over truncation, deliberately: the brain's prompt says "Recommend ONLY products from the
 * CATALOG below" and "never invent products" (widget-brain/src/brain.ts). A truncated catalog therefore
 * doesn't produce a smaller answer — it produces a CONFIDENT FALSE ONE ("we don't carry that") about a
 * product the merchant does carry, to a shopper who was ready to buy, in a response that looks completely
 * healthy to every monitor. And because Shopify's default connection order is `sortKey: ID`, the survivors
 * are the oldest SKUs, not the relevant ones. A throw, by contrast, is the input the caching wrapper is
 * built for: an already-serving merchant keeps its last-known-good COMPLETE catalog (stale-while-error),
 * and only a merchant that was over the ceiling before its first successful fetch degrades to safe-empty —
 * where the agent says it cannot find products, which is a true statement about its own knowledge rather
 * than a false one about the store. Truncation would also POISON the cache: a partial catalog gets stored
 * as last-known-good and then served for the whole TTL (and beyond, as the stale fallback).
 *
 * Worst-case latency: MAX_CATALOG_PAGES × timeoutMs = 4 × 4000 = 16s, hard-bounded (a slow store cannot
 * hang a job). On the /chat path createCachingGroundingPort applies its own, tighter hard timeout
 * (3s default) to this whole call, so a shopper request degrades to stale/safe-empty long before 16s.
 */
export function storefrontFetch(
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  opts: {
    version?: string;
    first?: number;
    timeoutMs?: number;
    /** Page ceiling; defaults to MAX_CATALOG_PAGES. Injectable so tests exercise the ceiling cheaply. */
    maxPages?: number;
    log?: (info: StorefrontEgressLog) => void;
  } = {},
): StorefrontFetch {
  const version = opts.version ?? STOREFRONT_API_VERSION;
  const first = opts.first ?? STOREFRONT_PAGE_SIZE;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS;
  const maxPages = Math.max(1, Math.floor(opts.maxPages ?? MAX_CATALOG_PAGES));
  // (c) Egress observability: log host + HTTP status + latency per PAGE (NEVER the token) so operators
  // can see Shopify health/misrouting during rollout, plus one `reason` line on an abnormal pagination
  // outcome. Injectable for tests; defaults to console.log → Cloud Logging. The thrown errors stay
  // static + unlogged (F1); these lines are structured + token-free.
  const log = opts.log ?? ((info: StorefrontEgressLog) => console.log("[grounding.shopify] " + JSON.stringify(info)));
  return async (creds) => {
    if (!SHOP_HOST.test(creds.shopDomain)) {
      throw new Error("refusing Shopify fetch: shopDomain is not a *.myshopify.com host"); // never leak the token
    }
    const url = `https://${creds.shopDomain}/api/${version}/graphql.json`;
    const startedAll = Date.now();

    // Observability must never break the fetch — swallow any (injected) logger error.
    const emit = (info: StorefrontEgressLog): void => {
      try {
        log(info);
      } catch {
        /* ignore logging errors */
      }
    };

    /** One page = one network call, with its own timeout and its own egress log line. */
    const requestPage = async (page: number, after: string | undefined): Promise<StorefrontData> => {
      const start = Date.now();
      let status = 0;
      let ok = false;
      let nodeCount: number | undefined;
      try {
        const res = await fetchFn(url, {
          method: "POST",
          headers: { "content-type": "application/json", "Shopify-Storefront-Private-Token": creds.accessToken },
          body: JSON.stringify({
            query: page === 1 ? STOREFRONT_QUERY : STOREFRONT_PAGE_QUERY,
            // `after: null` on page 1 = from the start of the list (the argument is a nullable String).
            variables: { first, after: after ?? null },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        status = res.status;
        ok = res.ok;
        // These errors are swallowed by the caching wrapper (degrade to stale/safe-empty) and must NEVER be
        // logged. Messages are STATIC — no vendor/credential content can ride an error into a future logger (F1).
        if (!res.ok) throw new Error("Shopify Storefront API request failed");
        const json = (await res.json()) as { data?: StorefrontData; errors?: Array<{ message?: string }> };
        if (Array.isArray(json.errors) && json.errors.length) {
          throw new Error("Shopify Storefront GraphQL error");
        }
        const data = json.data ?? {};
        nodeCount = data.products?.nodes?.length ?? 0;
        return data;
      } finally {
        emit({ host: creds.shopDomain, status, ok, ms: Date.now() - start, page, nodes: nodeCount });
      }
    };

    const nodes: StorefrontProductNode[] = [];
    let shop: StorefrontData["shop"];
    let after: string | undefined;

    /** The loud line. `status: 0` = no HTTP request; this is a local pagination decision. */
    const report = (page: number, reason: StorefrontEgressReason): void =>
      emit({ host: creds.shopDomain, status: 0, ok: false, ms: Date.now() - startedAll, page, products: nodes.length, maxPages, reason });

    for (let page = 1; ; page++) {
      let data: StorefrontData;
      try {
        data = await requestPage(page, after);
      } catch (e) {
        // A page-1 failure is the pre-existing "fetch failed" case (already visible on its own log line).
        // A page-2+ failure is the new, otherwise-invisible event: we are throwing away a partial catalog
        // rather than letting it masquerade as a complete small one.
        if (page > 1) report(page, "pagination-discarded-partial");
        throw e;
      }
      if (page === 1) shop = data.shop;
      nodes.push(...(data.products?.nodes ?? []));

      const info = data.products?.pageInfo;
      // Anything other than an explicit `true` means "done" — a missing hasNextPage never means "keep going".
      if (info?.hasNextPage !== true) {
        // Complete by construction, so no pagination state is surfaced on the returned value.
        return { shop, products: { nodes } };
      }
      if (page >= maxPages) {
        report(page, "catalog-ceiling-exceeded");
        throw new Error("Shopify Storefront catalog exceeds the supported size");
      }
      const cursor = info.endCursor;
      if (typeof cursor !== "string" || cursor.length === 0) {
        report(page, "pagination-cursor-missing");
        throw new Error("Shopify Storefront pagination cursor missing");
      }
      if (cursor === after) {
        // The same cursor twice means the next request would re-fetch the page we just read. Independently
        // of the page ceiling, this makes an infinite/repeating loop impossible.
        report(page, "pagination-cursor-stalled");
        throw new Error("Shopify Storefront pagination cursor did not advance");
      }
      after = cursor;
    }
  };
}

/** One-shot shell fetch: shop/policy only. Same host guard + token header + timeout as `storefrontFetch`,
 *  but no pagination loop. */
export function storefrontShellFetch(
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  opts: { version?: string; timeoutMs?: number; log?: (info: StorefrontEgressLog) => void } = {},
): StorefrontShellFetch {
  const version = opts.version ?? STOREFRONT_API_VERSION;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS;
  const log = opts.log ?? ((info: StorefrontEgressLog) => console.log("[grounding.shopify] " + JSON.stringify(info)));
  return async (creds) => {
    if (!SHOP_HOST.test(creds.shopDomain)) {
      throw new Error("refusing Shopify fetch: shopDomain is not a *.myshopify.com host");
    }
    const url = `https://${creds.shopDomain}/api/${version}/graphql.json`;
    const start = Date.now();
    let status = 0;
    let ok = false;
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json", "Shopify-Storefront-Private-Token": creds.accessToken },
        body: JSON.stringify({ query: STOREFRONT_SHELL_QUERY }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = res.status;
      ok = res.ok;
      if (!res.ok) throw new Error("Shopify Storefront API request failed");
      const json = (await res.json()) as { data?: StorefrontData; errors?: Array<{ message?: string }> };
      if (Array.isArray(json.errors) && json.errors.length) throw new Error("Shopify Storefront GraphQL error");
      return json.data ?? {};
    } finally {
      try { log({ host: creds.shopDomain, status, ok, ms: Date.now() - start, page: 0 }); } catch { /* ignore */ }
    }
  };
}

/**
 * By-id product fetch. `nodes(ids:)` returns the products for the given GIDs; a missing/delisted id
 * resolves to `null`, and a GID whose concrete type doesn't match the `... on Product` inline fragment
 * resolves to an object with none of the fragment's fields selected (no `id`) — both are dropped, never
 * mis-mapped into a product. The inline fragment requests the SAME fields as the page query so
 * `mapStorefrontToContext` maps the result identically.
 *
 * VERIFIED against PRIMARY DOCS (shopify.dev, Storefront API **2026-07**, retrieved **2026-08-16**):
 *   • .../api/storefront/latest/queries/nodes — `nodes(ids: [ID!]!): [Node]!`, one result per id, in the
 *     SAME order as the input, `null` for an id that doesn't resolve.
 *   • .../api/usage/limits — array arguments (including `nodes(ids:)`) accept a maximum of **250**
 *     elements per call; see `STOREFRONT_NODES_MAX` below.
 */
export const STOREFRONT_NODES_QUERY = `query PalUpGroundingByIds($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Product { id title description tags availableForSale priceRange { minVariantPrice { amount currencyCode } } variants(first: 1) { nodes { id } } }
  }
}`;

/** Max ids per `nodes(ids:)` call — "array arguments accept a maximum of 250 elements" (citation above). */
export const STOREFRONT_NODES_MAX = 250;

export type StorefrontByIdFetch = (creds: ShopifyStoreCreds, ids: string[]) => Promise<StorefrontData>;

/**
 * S3 §C — fetch ONLY the named products by Storefront GID, so a webhook can refresh exactly the SKUs that
 * changed instead of paging the whole catalog. Returns the same `StorefrontData` shape the pagination path
 * does (`{ products: { nodes } }`) so it flows through `mapStorefrontToContext` unchanged. Same host guard +
 * private-token header + per-request timeout as `storefrontFetch`; the token never leaves this path and is
 * never logged.
 *
 * CHUNKED at `STOREFRONT_NODES_MAX` (250): `nodes(ids:)` errors above that many ids in one call, and a
 * webhook-coalesced batch (T6) can exceed it, so the ceiling lives HERE — every caller (T5/T6) is safe
 * without chunking itself. Each slice is its own POST + its own egress log line (`page` = 1-based slice
 * index); resolved products across ALL slices are merged into one result. The "return only resolved
 * products; caller recovers missing ids via set-difference against what it asked for" contract is
 * UNCHANGED by chunking — a null (or non-Product) node in any slice is still simply absent from the merged
 * result, same as a single-call fetch.
 */
export function storefrontFetchByIds(
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  opts: { version?: string; timeoutMs?: number; log?: (info: StorefrontEgressLog) => void } = {},
): StorefrontByIdFetch {
  const version = opts.version ?? STOREFRONT_API_VERSION;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS;
  const log = opts.log ?? ((info: StorefrontEgressLog) => console.log("[grounding.shopify] " + JSON.stringify(info)));
  return async (creds, ids) => {
    if (ids.length === 0) return { products: { nodes: [] } };
    if (!SHOP_HOST.test(creds.shopDomain)) {
      throw new Error("refusing Shopify fetch: shopDomain is not a *.myshopify.com host"); // never leak the token
    }
    const url = `https://${creds.shopDomain}/api/${version}/graphql.json`;
    const nodes: StorefrontProductNode[] = [];
    for (let offset = 0; offset < ids.length; offset += STOREFRONT_NODES_MAX) {
      const batch = ids.slice(offset, offset + STOREFRONT_NODES_MAX);
      const page = offset / STOREFRONT_NODES_MAX + 1;
      const start = Date.now();
      let status = 0;
      let ok = false;
      let nodeCount: number | undefined;
      try {
        const res = await fetchFn(url, {
          method: "POST",
          headers: { "content-type": "application/json", "Shopify-Storefront-Private-Token": creds.accessToken },
          body: JSON.stringify({ query: STOREFRONT_NODES_QUERY, variables: { ids: batch } }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        status = res.status;
        ok = res.ok;
        if (!res.ok) throw new Error("Shopify Storefront API request failed"); // static; caching wrapper degrades
        const json = (await res.json()) as { data?: { nodes?: (StorefrontProductNode | null)[] }; errors?: Array<{ message?: string }> };
        if (Array.isArray(json.errors) && json.errors.length) throw new Error("Shopify Storefront GraphQL error");
        const batchNodes = (json.data?.nodes ?? []).filter((n): n is StorefrontProductNode => n != null && typeof n.id === "string");
        nodeCount = batchNodes.length;
        nodes.push(...batchNodes);
      } finally {
        try {
          log({ host: creds.shopDomain, status, ok, ms: Date.now() - start, page, nodes: nodeCount });
        } catch {
          /* ignore logging errors */
        }
      }
    }
    return { products: { nodes } };
  };
}

/** GroundingPort backed by a merchant's Shopify store. `fetchImpl` defaults to the live Storefront call. */
export function createShopifyGroundingAdapter(
  creds: ShopifyStoreCreds,
  fetchImpl: StorefrontFetch = storefrontFetch(),
  shellFetchImpl: StorefrontShellFetch = storefrontShellFetch(),
): GroundingPort {
  return {
    async getContext(tenantId: string): Promise<GroundingContext> {
      const data = await fetchImpl(creds);
      return mapStorefrontToContext(tenantId, data);
    },
    async getShell(tenantId: string): Promise<GroundingShell> {
      const data = await shellFetchImpl(creds);
      return mapStorefrontToShell(tenantId, data);
    },
  };
}
