import type {
  CatalogProductPort,
  CatalogProductRecord,
  CatalogProductVariant,
  ProductFact,
  ProductFactsPort,
  RuntimeStatePort,
} from "@palup/platform-ports";
import { matchedCostCap, matchedKill, RUNTIME_AGENT_TYPE } from "@palup/state-postgres";
import {
  createShopifyAdminClient,
  ShopifyClientError,
  type BulkStatus,
  type ShopifyAdminClient,
  type ShopifyAdminCreds,
} from "../shopify-client.js";
import { contentHash, MAX_INDEXED_PRODUCTS, type CatalogProductByIdSource } from "./catalog-index.js";

// Task 7 (durable-catalog-sync, spec §13.3) — the Shopify Bulk-Operations CATALOG BACKFILL driver: a
// one-shot (operator-run or scheduled) job that pulls a merchant's WHOLE catalog through Shopify's Bulk
// Operations API (not the paginated Storefront API `catalog-index.ts` uses for its ongoing poll/reconcile
// cycle) and lands the FULL Admin-shape product record — every variant, the real description, tags,
// productType, vendor, options, and the online-store URL — into `CatalogProductPort` + `ProductFactsPort`.
//
// WHY A SEPARATE JOB FROM `catalog-index.ts`'s full crawl. That job's `catalog: CatalogSource` reads the
// Storefront API, which only ever exposes ONE flat variant's worth of fields per product
// (`catalogProductRecordsFrom`'s "gap 2" comment) — it can build a correct VECTOR CORPUS (title+tags+
// description is all `productEmbedText` needs) but cannot populate `catalog_product`'s rich columns. Bulk
// Operations is the Admin-API surface that actually returns the full multi-variant/description/tags/
// productType/vendor/options/onlineStoreUrl shape, and it is built for exactly this kind of "whole
// catalog, once" pull — the Storefront API has no bulk-export equivalent.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// THE CLOBBER — carried in from the Task 6 review, and RESOLVED here + in `catalog-index.ts`.
//
// Both `CatalogProductPort` adapters (`createInMemoryCatalogProductStore`, `PostgresCatalogProductStore`)
// do an unconditional full-column `upsertMany`. Task 6's `reconcileProducts` (the webhook-driven delta
// path) writes a THIN record built from the Storefront-shaped `Product` — one flat variant, no
// description/tags/productType/vendor/options/onlineStoreUrl. Left alone, the very FIRST product webhook
// after this backfill lands would null out every rich field this job just wrote, permanently, until the
// next full re-backfill.
//
// THE FIX (the "preferred" option from the Task 6 review ruling, task-7-brief.md): `catalog-index.ts` now
// carries an OPTIONAL `CatalogIndexDeps.catalogProductAdminSource` seam. When wired, `reconcileProducts`
// fetches the changed product(s) in the FULL Admin shape and writes THAT instead of the thin projection —
// single-source-shape, so backfill and delta agree. `makeCatalogProductByIdSource` below is the real
// implementation of that seam (a live Admin `nodes(ids:)` GraphQL call via the Task 3 client), sharing the
// SAME mapping function (`mapAdminProductNode`) this file's Bulk JSONL parser uses, so a targeted refetch
// and a bulk backfill can never disagree about what a "rich record" looks like.
//
// NOT WIRED INTO ANY REAL COMPOSITION HERE. Per the brief: "do NOT wire the real composition in
// server.ts — that's Task 13; inject via deps/opts." `makeCatalogProductByIdSource` exists so a test (and,
// later, Task 13's composition root) can pass it as `CatalogIndexDeps.catalogProductAdminSource`.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
//
// PORTABILITY (ADR-0001): all Shopify wire access goes through the Task 3 client
// (`createShopifyAdminClient` / `runBulkQuery` / `pollBulk` / `downloadJsonl`) — this file adds no new
// fetch calls of its own and knows nothing about HTTP.
//
// NOT LIVE-VERIFIED — READ BEFORE TRUSTING THIS IN PRODUCTION (task-7-brief.md's "Implementation note",
// spec §13.3). Two things below are pinned CONSERVATIVELY against Shopify's documented Bulk Operations
// behavior and self-authored fixtures, NOT against a live bulk export from this repo:
//   1. `PRODUCTS_BULK_QUERY`'s exact field/connection shape (in particular whether `images` is still the
//      right connection name vs. `media`, and whether `ProductVariant.image` vs. a variant-level `media`
//      edge is the live field on the Bulk-eligible API version).
//   2. `parseBulkProductsJsonl`'s assumption that Bulk Operations flattens each nested connection (variants,
//      images) into its own JSONL line carrying `__parentId` set to the ROOT product's `id`, with no
//      deeper nesting under `__parentId` chains (i.e. an image is not nested one level further under a
//      variant in this query shape).
// Both MUST be confirmed against a real `bulkOperationRunQuery` run before this driver is trusted against
// production traffic.

/** GID shape guards — mirrors `PRODUCT_GID_RE` (catalog-index.ts) and `productIdOf` (shopify-webhook-identity.ts). */
const PRODUCT_ID_RE = /^gid:\/\/shopify\/Product\/\d+$/;
const VARIANT_ID_RE = /^gid:\/\/shopify\/ProductVariant\/\d+$/;
const IMAGE_ID_RE = /^gid:\/\/shopify\/ProductImage\/\d+$/;

/**
 * The Bulk Operations query this job submits via `runBulkQuery`. Bulk-eligible connections are requested
 * WITHOUT pagination arguments (`first:`/`after:`) — Bulk auto-paginates and flattens the whole connection
 * into JSONL lines; a `first:` argument on a bulk query is rejected by Shopify. NOT LIVE-VERIFIED (file
 * banner): confirm this exact field/connection shape against a live bulk export before trusting it.
 *
 * DELIBERATELY OMITTED: any inventory-quantity field (F8 — this job must never carry a raw stock count
 * across the boundary, only `availableForSale`'s boolean). `metafields`/`media` are also omitted — out of
 * scope for this task's rich-column set (`CatalogProductRecord` has no slot for either).
 */
export const PRODUCTS_BULK_QUERY = `{
  products {
    edges {
      node {
        id
        handle
        title
        descriptionHtml
        status
        productType
        vendor
        tags
        onlineStoreUrl
        options { name values }
        images {
          edges { node { url } }
        }
        variants {
          edges {
            node {
              id
              title
              sku
              price
              availableForSale
              image { url }
              selectedOptions { name value }
            }
          }
        }
      }
    }
  }
}`;

/** One variant as parsed off the Bulk JSONL — the Admin-shape equivalent of `CatalogProductVariant`. */
export interface AdminVariantNode {
  id: string;
  title?: string;
  sku?: string;
  price?: string;
  availableForSale?: boolean;
  imageUrl?: string;
  options?: Record<string, string>;
}

/** One product as parsed off the Bulk JSONL, with its variant/image child lines already re-attached. */
export interface AdminProductNode {
  id: string;
  handle: string;
  title: string;
  descriptionHtml?: string;
  status: "active" | "archived" | "draft";
  productType?: string;
  vendor?: string;
  tags?: string[];
  onlineStoreUrl?: string;
  options?: { name: string; values: string[] }[];
  imageUrls: string[];
  featuredImageUrl?: string;
  variants: AdminVariantNode[];
}

/** Shopify's `ProductStatus` enum is `ACTIVE | ARCHIVED | DRAFT` (uppercase). Anything else (missing,
 *  malformed, a future enum value this job doesn't know about) defaults to `"active"` — the SAME
 *  conservative default `catalogProductRecordsFrom` (catalog-index.ts) already uses for the thin path,
 *  rather than inventing a `draft`/`archived` state with no evidence for it. */
function normalizeStatus(raw: unknown): "active" | "archived" | "draft" {
  const s = typeof raw === "string" ? raw.toLowerCase() : "";
  return s === "archived" || s === "draft" ? s : "active";
}

/** Naive HTML→text fallback for `descriptionText` (mirrors nothing upstream — Bulk only returns
 *  `descriptionHtml`). Strips tags and collapses whitespace; NOT a sanitizer and never used for render —
 *  `descriptionHtml` remains the field a renderer should prefer. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse a completed bulk operation's JSONL result into `AdminProductNode[]`. Bulk Operations flattens
 * every nested connection (here: `variants`, `images`) into its own JSONL line, each carrying a
 * `__parentId` naming the ROOT product's `id` — this is the "implementation note" shape from the brief,
 * NOT LIVE-VERIFIED (file banner). A line with no `__parentId` is a root Product line. Malformed JSON on
 * any single line fails the WHOLE parse (a partial catalog silently missing an unknown number of products
 * is worse than a loud failure — mirrors `planProducts`'s "refuse rather than silently drop" discipline in
 * catalog-index.ts). An unrecognised CHILD line (a future connection this query doesn't request, or an id
 * shape neither a variant nor an image) is skipped rather than failing the parse — forward-compatible with
 * Shopify adding fields this job doesn't map yet.
 */
export function parseBulkProductsJsonl(jsonl: string): AdminProductNode[] {
  const roots = new Map<string, AdminProductNode>();
  const variantsByParent = new Map<string, AdminVariantNode[]>();
  const imagesByParent = new Map<string, string[]>();

  const lines = jsonl.split("\n");
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const trimmed = lines[lineNo]!.trim();
    if (!trimmed) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      throw new ShopifyClientError(`Shopify bulk JSONL line ${lineNo + 1} is not valid JSON — refusing a partial catalog`);
    }
    const parentId = typeof row.__parentId === "string" ? row.__parentId : undefined;
    const id = typeof row.id === "string" ? row.id : undefined;

    if (!parentId) {
      if (id && PRODUCT_ID_RE.test(id)) {
        const tags = Array.isArray(row.tags) ? (row.tags.filter((t) => typeof t === "string") as string[]) : [];
        const options = Array.isArray(row.options)
          ? (row.options as { name?: unknown; values?: unknown }[])
              .filter((o) => typeof o.name === "string" && Array.isArray(o.values))
              .map((o) => ({ name: o.name as string, values: (o.values as unknown[]).filter((v) => typeof v === "string") as string[] }))
          : undefined;
        roots.set(id, {
          id,
          handle: typeof row.handle === "string" ? row.handle : "",
          title: typeof row.title === "string" ? row.title : "",
          ...(typeof row.descriptionHtml === "string" && row.descriptionHtml ? { descriptionHtml: row.descriptionHtml } : {}),
          status: normalizeStatus(row.status),
          ...(typeof row.productType === "string" && row.productType ? { productType: row.productType } : {}),
          ...(typeof row.vendor === "string" && row.vendor ? { vendor: row.vendor } : {}),
          ...(tags.length > 0 ? { tags } : {}),
          ...(typeof row.onlineStoreUrl === "string" && row.onlineStoreUrl ? { onlineStoreUrl: row.onlineStoreUrl } : {}),
          ...(options && options.length > 0 ? { options } : {}),
          imageUrls: [],
          variants: [],
        });
      }
      // Any other unparented row kind (a future top-level connection this query doesn't request) is
      // ignored rather than failing the parse.
      continue;
    }

    if (id && VARIANT_ID_RE.test(id)) {
      const options: Record<string, string> = {};
      if (Array.isArray(row.selectedOptions)) {
        for (const o of row.selectedOptions as { name?: unknown; value?: unknown }[]) {
          if (typeof o?.name === "string" && typeof o?.value === "string") options[o.name] = o.value;
        }
      }
      const image = row.image as { url?: unknown } | undefined;
      const v: AdminVariantNode = {
        id,
        ...(typeof row.title === "string" && row.title ? { title: row.title } : {}),
        ...(typeof row.sku === "string" && row.sku ? { sku: row.sku } : {}),
        ...(typeof row.price === "string" ? { price: row.price } : typeof row.price === "number" ? { price: String(row.price) } : {}),
        // F8: boolean only. This query never requests an inventory-quantity field, so there is no raw
        // stock count to carry through even if a future response somehow included one.
        ...(typeof row.availableForSale === "boolean" ? { availableForSale: row.availableForSale } : {}),
        ...(image && typeof image.url === "string" ? { imageUrl: image.url } : {}),
        ...(Object.keys(options).length > 0 ? { options } : {}),
      };
      const list = variantsByParent.get(parentId) ?? [];
      list.push(v);
      variantsByParent.set(parentId, list);
      continue;
    }

    if (id && IMAGE_ID_RE.test(id) && typeof row.url === "string") {
      const list = imagesByParent.get(parentId) ?? [];
      list.push(row.url);
      imagesByParent.set(parentId, list);
      continue;
    }
    // Unrecognised child line — skipped (forward-compatible; see doc comment above).
  }

  for (const [parentId, product] of roots) {
    product.variants = variantsByParent.get(parentId) ?? [];
    product.imageUrls = imagesByParent.get(parentId) ?? [];
    if (product.imageUrls.length > 0) product.featuredImageUrl = product.imageUrls[0];
  }
  return [...roots.values()];
}

/**
 * A canonical, deterministic projection of the fields that matter for change detection — EVERYTHING a
 * `CatalogProductRecord` renders, so a real edit (a new variant, a price change, a re-tagged product)
 * always changes the hash. Deliberately NOT the same input `catalog-index.ts`'s `contentHash` hashes
 * (that one hashes ONLY the embed text — title+tags+description — because it exists to gate an expensive
 * re-EMBED, and a price/variant change must not force a re-embed). This job's hash instead gates an
 * expensive re-UPSERT of the whole rich record, so it must be sensitive to every rich field.
 */
function adminProductContentHash(p: AdminProductNode): string {
  const canonical = JSON.stringify({
    title: p.title,
    descriptionHtml: p.descriptionHtml ?? "",
    productType: p.productType ?? "",
    vendor: p.vendor ?? "",
    tags: [...(p.tags ?? [])].sort(),
    status: p.status,
    options: p.options ?? [],
    onlineStoreUrl: p.onlineStoreUrl ?? "",
    imageUrls: p.imageUrls,
    variants: [...p.variants]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((v) => ({
        id: v.id,
        title: v.title ?? "",
        sku: v.sku ?? "",
        price: v.price ?? "",
        availableForSale: v.availableForSale ?? null,
        imageUrl: v.imageUrl ?? "",
        options: v.options ?? {},
      })),
  });
  return contentHash(canonical);
}

/**
 * Project one parsed Admin product into the rich `CatalogProductRecord` this store persists. The SAME
 * function backs both the bulk-backfill path (below) and `makeCatalogProductByIdSource`'s targeted
 * refetch, so a backfill and a later delta refetch can never disagree about what "rich" means
 * (single-source-shape, the Task 6 review's preferred fix).
 */
export function mapAdminProductNode(p: AdminProductNode, now: Date): CatalogProductRecord {
  const variants: CatalogProductVariant[] = p.variants.map((v) => ({
    variantId: v.id,
    ...(v.title ? { title: v.title } : {}),
    ...(v.sku ? { sku: v.sku } : {}),
    ...(v.price !== undefined ? { price: v.price } : {}),
    ...(v.availableForSale !== undefined ? { availableForSale: v.availableForSale } : {}),
    ...(v.imageUrl ? { imageUrl: v.imageUrl } : {}),
    ...(v.options ? { options: v.options } : {}),
  }));
  return {
    productId: p.id,
    handle: p.handle,
    title: p.title,
    ...(p.descriptionHtml ? { descriptionHtml: p.descriptionHtml, descriptionText: stripHtml(p.descriptionHtml) } : {}),
    ...(p.productType ? { productType: p.productType } : {}),
    ...(p.vendor ? { vendor: p.vendor } : {}),
    ...(p.tags && p.tags.length > 0 ? { tags: p.tags } : {}),
    status: p.status,
    ...(p.options && p.options.length > 0 ? { options: p.options } : {}),
    variants,
    ...(p.featuredImageUrl ? { featuredImageUrl: p.featuredImageUrl } : {}),
    ...(p.imageUrls.length > 0 ? { imageUrls: p.imageUrls } : {}),
    ...(p.onlineStoreUrl ? { onlineStoreUrl: p.onlineStoreUrl } : {}),
    contentHash: adminProductContentHash(p),
    syncedAt: now.toISOString(),
  };
}

/**
 * Project one rich record into its `ProductFact` (the Tier-2 money fact `ProductFactsPort` serves).
 * KNOWN SIMPLIFICATION, carried forward from `catalogProductRecordsFrom`'s identical limitation
 * (catalog-index.ts, "gap 2"): a multi-variant product has no single "the" price, and `ProductFact` is
 * one string per PRODUCT — this reports the FIRST variant's price/availability, not a range. `ProductFact`
 * is never the thing a shopper is directly quoted from without `GroundingContext` re-confirming it live
 * (money/NN#1, catalog-index.ts's `productEmbedText` comment), so this is an administrative/serving hint,
 * not a new money-accuracy risk beyond what Task 6 already accepted. A product with zero variants (or
 * whose first variant carries no price at all) yields no fact — never a fabricated price.
 */
export function productFactFromRecord(r: CatalogProductRecord, now: Date): ProductFact | undefined {
  const first = r.variants[0];
  if (!first?.price) return undefined;
  return {
    productId: r.productId,
    price: first.price,
    ...(first.availableForSale !== undefined ? { availableForSale: first.availableForSale } : {}),
    source: "backfill:catalog-backfill",
    updatedAt: now.toISOString(),
  };
}

export interface BackfillReport {
  tenantId: string;
  /** Products actually written to `catalog_product` this run (post ceiling-truncation, post status filter). */
  productCount: number;
  /** True when the discovered (post-filter) catalog exceeded the ceiling and was truncated (NN#5: never silent). */
  truncated: boolean;
  outcome: "backfilled" | "unchanged" | "halted" | "capped";
}

export interface CatalogBackfillOpts {
  /** Ceiling override; defaults to `MAX_INDEXED_PRODUCTS` (mirrors `CatalogIndexOpts.maxProducts`). */
  maxProducts?: number;
  /** Keep draft/archived products too. Default `false`: ONLY `status === "active"` products are persisted
   *  — mirrors the live storefront (what `catalog-index.ts`'s Storefront-driven full crawl already only
   *  ever sees) and keeps `catalog_product` from surfacing a product no shopper can actually buy. */
  includeNonActive?: boolean;
  /** Force every candidate to be rewritten, bypassing the content-hash skip. */
  reindex?: boolean;
  /** Poll cadence for `pollBulk`. Defaults below are production-shaped; tests inject a no-op `sleep`. */
  pollIntervalMs?: number;
  /** Poll attempts before giving up (bulk operations can legitimately take minutes on a large catalog). */
  maxPolls?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_POLLS = 150; // ~5 minutes at the default 2s cadence

/** Audit actor for every write this job makes — distinct from `CATALOG_INDEX_ACTOR` (catalog-index.ts)
 *  since this is a different job with a different reversal path. */
export const CATALOG_BACKFILL_ACTOR = "catalog-backfill-job";

export const BACKFILL_MANIFEST_COLLECTION = "catalog_backfill";
export const BACKFILL_MANIFEST_KEY = "manifest";

/**
 * Idempotent/resumable progress record — mirrors `CatalogManifest`/`writeManifestAndAudit`
 * (catalog-index.ts) in SPIRIT (a KV record committed alongside its audit entry) but is its OWN record
 * under its OWN collection: this job's per-id content hash means something different from the corpus
 * ledger's (see `adminProductContentHash`'s doc comment), and writing into `catalog_index`'s ledger
 * collection would corrupt the vector-corpus reconcile's own diffing.
 *
 * SCALE CAVEAT (recorded, not silently assumed away): `hashes` is a single flat map in ONE KV value. The
 * corpus ledger this mirrors chunks itself at `LEDGER_CHUNK_SIZE` (10k ids/chunk, catalog-ledger.ts)
 * specifically to stay under a KV value-size limit at the `MAX_INDEXED_PRODUCTS` (50k) ceiling this job
 * shares. This manifest does NOT chunk yet — fine at the small-to-mid catalog sizes this has been
 * exercised against, but a tenant near the 50k ceiling could hit a value-size limit the ledger already
 * solved for. Chunking this manifest the same way is the natural follow-up before a very large merchant's
 * backfill is run for real; flagged here rather than silently assumed solved.
 */
interface BackfillManifest {
  /** productId → contentHash, as of the last successful write. */
  hashes: Record<string, string>;
  productCount: number;
  truncated: boolean;
  at: string;
}

export interface CatalogBackfillDeps {
  store: RuntimeStatePort;
  catalogProduct: CatalogProductPort;
  /** OPTIONAL, mirrors `CatalogIndexDeps.productFacts` — absent ⇒ this job writes nothing there. */
  productFacts?: ProductFactsPort;
  /** Task 5 — obtain a token that is not about to expire, refreshing it first if needed. */
  getFreshAdminToken: (tenantId: string) => Promise<string>;
  /** Resolve a tenantId to the shop domain the Admin client needs. Caller-supplied, same reason
   *  `AdminTokenRefresherDeps.shopDomainOf` is (admin-token-refresh.ts) — this module has no merchant
   *  registry of its own. */
  shopDomainOf: (tenantId: string) => Promise<string>;
  /** Injectable client factory for tests. Defaults to `createShopifyAdminClient({ creds, fetchFn, sleep })`. */
  createClient?: (creds: ShopifyAdminCreds) => ShopifyAdminClient;
  /** Passed through to the default `createClient` only; ignored when `createClient` is supplied. */
  fetchFn?: typeof globalThis.fetch;
  /** Injectable sleep for the poll loop (tests pass `async () => {}`). Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `pollBulk` until COMPLETED, throwing on FAILED/CANCELED or attempt exhaustion — never an infinite
 *  loop (mirrors `ShopifyThrottleError`'s bounded-attempts discipline in shopify-client.ts). */
async function pollUntilComplete(
  client: ShopifyAdminClient,
  id: string,
  opts: { sleep: (ms: number) => Promise<void>; pollIntervalMs: number; maxPolls: number },
): Promise<BulkStatus> {
  for (let attempt = 1; attempt <= opts.maxPolls; attempt++) {
    const status = await client.pollBulk(id);
    if (status.status === "COMPLETED") return status;
    if (status.status === "FAILED" || status.status === "CANCELED") {
      throw new ShopifyClientError(
        `Shopify bulk operation ${id} ended in ${status.status}${status.errorCode ? ` (${status.errorCode})` : ""}`,
      );
    }
    if (attempt < opts.maxPolls) await opts.sleep(opts.pollIntervalMs);
  }
  throw new ShopifyClientError(`Shopify bulk operation ${id} did not complete after ${opts.maxPolls} polls`);
}

/**
 * Run the Bulk-Operations catalog backfill for one tenant: submit the bulk query, poll to completion,
 * download and parse the JSONL, map to rich `CatalogProductRecord`/`ProductFact` rows, truncate at the
 * ceiling (loudly — NN#5), skip unchanged rows by content hash, and upsert the rest. Idempotent: a re-run
 * against an unchanged catalog performs ZERO `catalogProduct`/`productFacts` writes (verified by the
 * manifest committed in the prior run).
 *
 * DOES NOT touch the vector corpus. `catalog-index.ts`'s embed text (`productEmbedText`) is built from
 * title+tags+description only, and the Storefront API this job's sibling already reads carries all three
 * in full — there is no richer embed text this job's Admin-shape data could contribute, so re-embedding
 * here would spend money for zero retrieval benefit. The corpus stays maintained by the existing scheduled
 * `runCatalogIndex` poll, unaffected by this job running or not.
 *
 * NN#4 (a halted/capped tenant does no proactive work): checked once, up front — a bulk operation is a
 * single all-or-nothing Shopify-side job (unlike the incremental embed loop `indexOneTenant` re-checks per
 * batch), so there is no natural "batch boundary" partway through to re-check against.
 */
export async function runCatalogBackfill(
  deps: CatalogBackfillDeps,
  tenantId: string,
  opts: CatalogBackfillOpts = {},
): Promise<BackfillReport> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const maxProducts = Math.max(1, Math.floor(opts.maxProducts ?? MAX_INDEXED_PRODUCTS));

  if (await matchedKill(deps.store, { tenantId, agentType: RUNTIME_AGENT_TYPE })) {
    return { tenantId, productCount: 0, truncated: false, outcome: "halted" };
  }
  if (await matchedCostCap(deps.store, { tenantId })) {
    return { tenantId, productCount: 0, truncated: false, outcome: "capped" };
  }

  const token = await deps.getFreshAdminToken(tenantId);
  const shopDomain = await deps.shopDomainOf(tenantId);
  const creds: ShopifyAdminCreds = { shopDomain, accessToken: token };
  const client = deps.createClient
    ? deps.createClient(creds)
    : createShopifyAdminClient({ creds, fetchFn: deps.fetchFn, sleep });

  const { id } = await client.runBulkQuery(PRODUCTS_BULK_QUERY);
  const status = await pollUntilComplete(client, id, {
    sleep,
    pollIntervalMs: opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    maxPolls: opts.maxPolls ?? DEFAULT_MAX_POLLS,
  });

  // A COMPLETED bulk operation with zero matching rows can legitimately omit `url` (NOT LIVE-VERIFIED —
  // file banner) — treated as an empty catalog, not a failure.
  const parsed = status.url ? parseBulkProductsJsonl(await client.downloadJsonl(status.url)) : [];

  const filtered = opts.includeNonActive ? parsed : parsed.filter((p) => p.status === "active");

  let truncated = false;
  let candidates = filtered;
  if (filtered.length > maxProducts) {
    truncated = true;
    const dropped = filtered.length - maxProducts;
    candidates = filtered.slice(0, maxProducts);
    // The loud line (NN#5 — no silent cap). Class/count only, no product content, mirroring the
    // PII/credential-free discipline `indexOneTenant`'s other operator-log lines follow.
    console.error(
      `[catalog-backfill] ALERT truncated tenant=${tenantId} kept=${candidates.length} dropped=${dropped} ceiling=${maxProducts}`,
    );
  }

  const at = now();
  const records = candidates.map((p) => mapAdminProductNode(p, at));

  const manifest = await deps.store.get<BackfillManifest>({ tenantId }, BACKFILL_MANIFEST_COLLECTION, BACKFILL_MANIFEST_KEY);
  const priorHashes = manifest?.hashes ?? {};
  const toWrite = opts.reindex ? records : records.filter((r) => priorHashes[r.productId] !== r.contentHash);

  if (toWrite.length > 0) {
    await deps.catalogProduct.upsertMany(tenantId, toWrite);
    if (deps.productFacts) {
      const facts = toWrite
        .map((r) => productFactFromRecord(r, at))
        .filter((f): f is ProductFact => f !== undefined);
      if (facts.length > 0) await deps.productFacts.upsertMany(tenantId, facts);
    }
  }

  const newHashes: Record<string, string> = { ...priorHashes };
  for (const r of records) newHashes[r.productId] = r.contentHash;
  const manifestOut: BackfillManifest = { hashes: newHashes, productCount: records.length, truncated, at: at.toISOString() };
  const outcome: BackfillReport["outcome"] = toWrite.length > 0 || !manifest ? "backfilled" : "unchanged";

  await deps.store.tx({ tenantId }, async (t) => {
    await t.put(BACKFILL_MANIFEST_COLLECTION, BACKFILL_MANIFEST_KEY, manifestOut);
    await t.audit({
      actor: CATALOG_BACKFILL_ACTOR,
      action: "catalog_backfill.run",
      input: { tenantId, productCount: records.length, written: toWrite.length, truncated, ceiling: maxProducts },
      decision: outcome,
      reversalPath:
        `CatalogProductPort.deleteTenant / ProductFactsPort.deleteTenant erase these rows for tenant ${tenantId}; ` +
        "a future backfill run (or the periodic catalog-index poll, for non-rich fields) overwrites them",
    });
  });

  return { tenantId, productCount: records.length, truncated, outcome };
}

/**
 * The real implementation of `CatalogIndexDeps.catalogProductAdminSource` (catalog-index.ts) — a targeted,
 * by-id Admin GraphQL fetch (NOT a bulk operation; bulk operations are for whole-catalog pulls and would
 * be wildly disproportionate for "refresh the one product a webhook just named"). Shares
 * `mapAdminProductNode` with the bulk-backfill path above, so a delta refetch and a backfill can never
 * disagree about what a rich record looks like (single-source-shape).
 *
 * NOT LIVE-VERIFIED (file banner): the `nodes(ids:)` query shape below is written to request the SAME
 * fields `PRODUCTS_BULK_QUERY` does (with ordinary `first:`-bounded connections, since this is a normal
 * synchronous query, not a bulk operation) — confirm against a live Admin call before trusting it in
 * production. NOT wired into any real composition here (Task 13's job); exported so a test — and later
 * Task 13 — can pass it directly as `CatalogIndexDeps.catalogProductAdminSource`.
 */
export function makeCatalogProductByIdSource(client: ShopifyAdminClient, now: () => Date = () => new Date()): CatalogProductByIdSource {
  return async (_tenantId, ids) => {
    if (ids.length === 0) return [];
    const query = `query PalUpProductsByIds($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product {
          id handle title descriptionHtml status productType vendor tags onlineStoreUrl
          options { name values }
          images(first: 20) { edges { node { url } } }
          variants(first: 100) {
            edges { node { id title sku price availableForSale image { url } selectedOptions { name value } } }
          }
        }
      }
    }`;
    const res = await client.graphql<{
      nodes: (
        | null
        | {
            id: string;
            handle?: string;
            title?: string;
            descriptionHtml?: string;
            status?: string;
            productType?: string;
            vendor?: string;
            tags?: string[];
            onlineStoreUrl?: string;
            options?: { name: string; values: string[] }[];
            images?: { edges?: { node?: { url?: string } }[] };
            variants?: {
              edges?: { node?: { id: string; title?: string; sku?: string; price?: string; availableForSale?: boolean; image?: { url?: string }; selectedOptions?: { name: string; value: string }[] } }[];
            };
          }
      )[];
    }>(query, { ids });

    const nodes = res.data?.nodes ?? [];
    const products: AdminProductNode[] = [];
    for (const n of nodes) {
      if (!n || !PRODUCT_ID_RE.test(n.id)) continue; // a nodes() miss (deleted/wrong type) is simply omitted
      const imageUrls = (n.images?.edges ?? []).map((e) => e.node?.url).filter((u): u is string => typeof u === "string");
      const variants: AdminVariantNode[] = (n.variants?.edges ?? [])
        .map((e) => e.node)
        .filter((v): v is NonNullable<typeof v> => v !== undefined)
        .map((v) => {
          const options: Record<string, string> = {};
          for (const o of v.selectedOptions ?? []) options[o.name] = o.value;
          return {
            id: v.id,
            ...(v.title ? { title: v.title } : {}),
            ...(v.sku ? { sku: v.sku } : {}),
            ...(v.price !== undefined ? { price: v.price } : {}),
            ...(v.availableForSale !== undefined ? { availableForSale: v.availableForSale } : {}),
            ...(v.image?.url ? { imageUrl: v.image.url } : {}),
            ...(Object.keys(options).length > 0 ? { options } : {}),
          };
        });
      products.push({
        id: n.id,
        handle: n.handle ?? "",
        title: n.title ?? "",
        ...(n.descriptionHtml ? { descriptionHtml: n.descriptionHtml } : {}),
        status: normalizeStatus(n.status),
        ...(n.productType ? { productType: n.productType } : {}),
        ...(n.vendor ? { vendor: n.vendor } : {}),
        ...(n.tags && n.tags.length > 0 ? { tags: n.tags } : {}),
        ...(n.onlineStoreUrl ? { onlineStoreUrl: n.onlineStoreUrl } : {}),
        ...(n.options && n.options.length > 0 ? { options: n.options } : {}),
        imageUrls,
        ...(imageUrls[0] ? { featuredImageUrl: imageUrls[0] } : {}),
        variants,
      });
    }
    if (products.length === 0) return undefined;
    const at = now();
    return products.map((p) => mapAdminProductNode(p, at));
  };
}
