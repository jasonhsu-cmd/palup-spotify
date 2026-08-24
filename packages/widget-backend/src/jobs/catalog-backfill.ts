import type {
  CatalogProductPort,
  CatalogProductRecord,
  CatalogProductVariant,
  ModelPort,
  Product,
  ProductFact,
  ProductFactsPort,
  RuntimeStatePort,
  StoreProfilePort,
  StoreProfileRecord,
  VectorPort,
  VectorRecord,
} from "@palup/platform-ports";
import { canEmbed, requireEmbedAlignment } from "@palup/platform-ports";
import { matchedCostCap, matchedKill, RUNTIME_AGENT_TYPE, type AdminTokenStore } from "@palup/state-postgres";
import {
  createShopifyAdminClient,
  ShopifyClientError,
  type BulkStatus,
  type ShopifyAdminClient,
  type ShopifyAdminCreds,
} from "../shopify-client.js";
import {
  CATALOG_CORPUS_PURPOSE,
  DEFAULT_EMBED_BATCH,
  MANIFEST_COLLECTION,
  MANIFEST_KEY,
  MAX_INDEXED_PRODUCTS,
  catalogNamespace,
  catalogRecordId,
  contentHash,
  productEmbedText,
  writeManifestAndAudit,
  type CatalogManifest,
  type CatalogProductByIdSource,
} from "./catalog-index.js";
import { listLedgerChunkKeys, readCorpusLedger, readCorpusLedgerTimestamps } from "./catalog-ledger.js";

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
  /**
   * Task 11 (F5) — an ABORT SIGNAL re-checked between poll/page steps, so an operator kill armed
   * MID-RUN stops this job promptly instead of waiting out a whole (potentially minutes-long) bulk
   * operation. This is a SEPARATE check from the up-front `matchedKill(..., RUNTIME_AGENT_TYPE)` above
   * (the live-shopper serving plane) — the scheduler that calls this job supplies a closure re-checking
   * `matchedKill(store, { tenantId, agentType: CATALOG_SYNC_AGENT_TYPE })`, the sync-plane's OWN kill
   * scope. Optional and absent by default: a caller that does not supply it gets byte-identical behavior
   * to before Task 11 (only the up-front halt/cap checks apply). Never thrown from — a `false`/resolved
   * value is all this reads.
   */
  shouldAbort?: () => Promise<boolean>;
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
  /**
   * Task 3 (credential-enrollment-unification) — OPTIONAL, paired with `vector` below. When BOTH are
   * present, this backfill ALSO builds the pgvector embedding corpus (title+tags+description embed text,
   * `productEmbedText` — same function `catalog-index.ts` uses) under `catalogNamespace(tenantId)`, with
   * its manifest/ledger committed to the SAME `MANIFEST_COLLECTION`/`MANIFEST_KEY` location
   * `catalog-index.ts`'s poll/reconcile job and `catalog-retriever.ts`'s reader already use — one corpus,
   * one manifest, regardless of which job built it. Absent (the default) ⇒ byte-identical to #439: no
   * vector writes, no Admin round-trip beyond the bulk operation.
   */
  model?: ModelPort;
  /** Paired with `model` above — see its doc comment. */
  vector?: VectorPort;
  /**
   * Task 3 — OPTIONAL. When present, a one-shot Admin `shop { name shopPolicies { type body } } ` query
   * (verified field shape — see `fetchStoreProfile`'s doc comment) is mapped to a `StoreProfileRecord` and
   * persisted via `storeProfile.put`. Absent (the default) ⇒ byte-identical to #439: no Admin shop-profile
   * call, no `store_profile` write.
   */
  storeProfile?: StoreProfilePort;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Bounds mirroring shopify-grounding.ts's `MAX_TITLE`/`MAX_POLICY` discipline (module-private there, so
 *  restated here rather than imported) — a merchant-supplied brand name or policy body is untrusted text
 *  that eventually reaches a prompt; length-bounding it here is the same data-minimization/anti-injection
 *  posture as the rest of this file's Bulk JSONL mapping. */
const STORE_PROFILE_MAX_TITLE = 200;
const STORE_PROFILE_MAX_POLICY = 2000;
function boundText(s: string | undefined, max: number): string {
  return (s ?? "").slice(0, max);
}

/**
 * The one-shot Admin GraphQL query for shop brand + policies (spec §10.2). The Bulk-Operations product
 * query (`PRODUCTS_BULK_QUERY`, above) carries NO shop-level fields at all — Bulk Operations is scoped to
 * a single top-level connection (`products`) and cannot also return `shop` — so brand/policy cannot be
 * read off the bulk response; this is a SEPARATE, ordinary (non-bulk) Admin GraphQL call over the same
 * rate-limited client (`shopify-client.ts`).
 *
 * FIELD SHAPE — VERIFIED against shopify.dev's Admin GraphQL reference (fetched 2026-08-24, `latest`
 * version), not fabricated:
 *   • `Shop.name: String!` — https://shopify.dev/docs/api/admin-graphql/latest/objects/Shop
 *   • `Shop.shopPolicies: [ShopPolicy!]!` — same page
 *   • `ShopPolicy.type: ShopPolicyType!`, `ShopPolicy.body: HTML!` —
 *     https://shopify.dev/docs/api/admin-graphql/latest/objects/ShopPolicy
 *   • `ShopPolicyType` enum includes `REFUND_POLICY` ("The refund policy") and `SHIPPING_POLICY` ("The
 *     shipping policy") — https://shopify.dev/docs/api/admin-graphql/latest/enums/ShopPolicyType
 * This is the ADMIN-API equivalent of the STOREFRONT-API shell query `shopify-grounding.ts` already uses
 * (`shop { name refundPolicy { body } shippingPolicy { body } }`) — the Storefront API exposes refund/
 * shipping policy as two direct fields, the Admin API exposes them as typed entries in one `shopPolicies`
 * list; the two are not interchangeable shapes, which is why this file adds its own query rather than
 * reusing that one (this job never holds a Storefront token, only an Admin one).
 */
const SHOP_PROFILE_QUERY = `query PalUpShopProfile {
  shop {
    name
    shopPolicies { type body }
  }
}`;

interface ShopProfileQueryResult {
  shop?: {
    name?: string;
    shopPolicies?: { type?: string; body?: string }[];
  };
}

/**
 * Fetch + map the shop's brand/policy via `SHOP_PROFILE_QUERY`. FAIL-SAFE, mirroring this file's other
 * optional-dep patterns (`productFacts`/`catalogProduct` writes above): a GraphQL error never fails the
 * whole backfill — it falls back to a CLEARLY-a-fallback profile (brand derived from the shop domain,
 * empty policy) rather than inventing merchant content. The caller (`runCatalogBackfill`) still persists
 * whatever this returns, so a transient Admin failure produces an honest placeholder, not a skipped write.
 */
async function fetchStoreProfile(client: ShopifyAdminClient, shopDomain: string): Promise<StoreProfileRecord> {
  const fallbackBrand = shopDomain.replace(/\.myshopify\.com$/i, "") || shopDomain;
  try {
    const res = await client.graphql<ShopProfileQueryResult>(SHOP_PROFILE_QUERY);
    const shop = res.data?.shop;
    const policies = shop?.shopPolicies ?? [];
    const bodyFor = (type: string): string | undefined => policies.find((p) => p?.type === type)?.body;
    const brandName = boundText(shop?.name, STORE_PROFILE_MAX_TITLE) || fallbackBrand;
    return {
      brandName,
      policy: {
        returns: boundText(bodyFor("REFUND_POLICY"), STORE_PROFILE_MAX_POLICY),
        shipping: boundText(bodyFor("SHIPPING_POLICY"), STORE_PROFILE_MAX_POLICY),
      },
    };
  } catch {
    return { brandName: fallbackBrand, policy: { returns: "", shipping: "" } };
  }
}

/** The embed text for one rich record — reuses `productEmbedText` (catalog-index.ts) verbatim by
 *  projecting the fields it reads (`title`/`tags`/`description`) into a throwaway `Product`-shaped value.
 *  `price`/`id` are never used by `productEmbedText` and this value is never persisted — it exists only to
 *  share the ONE embed-text builder rather than re-implement its title+tags+description join here. */
function embedTextFor(r: CatalogProductRecord): string {
  const pseudo: Product = { id: r.productId, title: r.title, description: r.descriptionText ?? "", price: "", tags: r.tags };
  return productEmbedText(pseudo);
}

/**
 * Task 3 — build/refresh the pgvector embedding corpus for the rich records this backfill just wrote,
 * sharing `catalog-index.ts`'s manifest/ledger location so a later `runCatalogIndex`/`reconcileProducts`
 * run sees this corpus as ITS OWN prior state (one corpus, one source of truth — never a second, competing
 * writer). Content-hash gated exactly like the full-crawl job's `indexOneTenant`: an unchanged product
 * (same embed text as last run) contributes NOTHING to `toEmbed`, so a re-run against an unchanged catalog
 * embeds zero.
 *
 * KNOWN SIMPLIFICATIONS versus `indexOneTenant`/`reconcileProducts` (documented, not silently narrower):
 *   • No S4 §F concurrency guard (`writtenAt`/`protectedIds`) — a webhook-driven reconcile racing THIS
 *     one-shot bulk backfill mid-run could have its just-written product treated as stale here. Acceptable
 *     for a one-shot operator-run backfill (not the continuous poll loop that guard was built for), but
 *     flagged rather than assumed away.
 *   • Pin-mismatch is checked once (on the first embed batch) and, on mismatch, this function skips the
 *     whole embed+write step for this run (loud ALERT log) rather than the full job's richer per-report
 *     `pin-mismatch` outcome — this function reports counts back to its caller instead of a discriminated
 *     outcome union.
 *   • `canEmbed(model) === false` is treated as "nothing to embed" (loud ALERT log), mirroring
 *     `indexOneTenant`'s `no-embed-capability` outcome in spirit but not as a typed report value.
 */
async function syncEmbeddingCorpus(
  store: RuntimeStatePort,
  model: ModelPort,
  vector: VectorPort,
  tenantId: string,
  records: CatalogProductRecord[],
  at: Date,
  ceiling: number,
): Promise<{ embedded: number; written: number; removed: number }> {
  if (!canEmbed(model)) {
    console.error(`[catalog-backfill] ALERT no_embed_capability tenant=${tenantId} — skipping corpus build`);
    return { embedded: 0, written: 0, removed: 0 };
  }

  const ns = catalogNamespace(tenantId);
  const plan = records
    .map((r) => {
      const text = embedTextFor(r);
      return text ? { productId: r.productId, recordId: catalogRecordId(r.productId), text, hash: contentHash(text) } : undefined;
    })
    .filter((p): p is { productId: string; recordId: string; text: string; hash: string } => p !== undefined);

  const priorChunkKeys = await listLedgerChunkKeys(store, tenantId);
  const ledger = await readCorpusLedger(store, tenantId);
  const ledgerWrittenAt = await readCorpusLedgerTimestamps(store, tenantId);
  const manifest = await store.get<CatalogManifest>({ tenantId }, MANIFEST_COLLECTION, MANIFEST_KEY);

  const wanted = new Set(plan.map((p) => p.recordId));
  const toEmbed = plan.filter((p) => ledger.get(p.recordId) !== p.hash);
  const stale = [...ledger.keys()].filter((id) => !wanted.has(id));

  if (toEmbed.length === 0 && stale.length === 0) {
    return { embedded: 0, written: 0, removed: 0 };
  }

  const vectors = new Map<string, number[]>();
  let pin: { model: string; dimension: number; purpose: string } | undefined;
  let pinMismatch = false;
  for (let i = 0; i < toEmbed.length && !pinMismatch; i += Math.max(1, DEFAULT_EMBED_BATCH)) {
    const batch = toEmbed.slice(i, i + Math.max(1, DEFAULT_EMBED_BATCH));
    const req = { texts: batch.map((p) => p.text), purpose: CATALOG_CORPUS_PURPOSE, tenantId };
    const res = await model.embed!(req);
    requireEmbedAlignment(req, res);
    if (!pin) {
      if (manifest && ledger.size > 0 && (manifest.model !== res.model || manifest.dimension !== res.dimension || manifest.purpose !== res.purpose)) {
        pinMismatch = true;
        break;
      }
      pin = { model: res.model, dimension: res.dimension, purpose: res.purpose };
    }
    batch.forEach((p, j) => vectors.set(p.recordId, res.vectors[j]!));
  }

  if (pinMismatch) {
    console.error(
      `[catalog-backfill] ALERT embed_pin_mismatch tenant=${tenantId} corpus=${manifest?.model}/${manifest?.dimension}d/${manifest?.purpose} — skipping corpus write this run`,
    );
    return { embedded: 0, written: 0, removed: 0 };
  }

  const byId = new Map(records.map((r) => [r.productId, r]));
  const vectorRecords: VectorRecord[] = toEmbed.map((p) => {
    const src = byId.get(p.productId);
    const firstVariantId = src?.variants[0]?.variantId;
    return {
      id: p.recordId,
      vector: vectors.get(p.recordId)!,
      metadata: {
        kind: "product",
        productId: p.productId,
        contentHash: p.hash,
        title: src?.title ?? "",
        ...(firstVariantId ? { variantId: firstVariantId } : {}),
        ...(src?.featuredImageUrl ? { imageUrl: src.featuredImageUrl } : {}),
      },
    };
  });

  if (vectorRecords.length > 0) await vector.upsert(ns, vectorRecords);
  if (stale.length > 0) await vector.deleteById(ns, stale);

  const newLedger = new Map(plan.map((p) => [p.recordId, p.hash]));
  const effectivePin =
    pin ?? (manifest && manifest.purpose ? { model: manifest.model, dimension: manifest.dimension, purpose: manifest.purpose } : undefined);
  if (!effectivePin) {
    // Nothing embedded (delete-only run) and no prior pin to carry forward — refuse to invent one
    // (mirrors indexOneTenant's identical refusal), simply leaving the manifest as it was.
    return { embedded: 0, written: vectorRecords.length, removed: stale.length };
  }

  const atMs = at.getTime();
  const newWrittenAt = new Map<string, number>();
  for (const [id, hash] of newLedger) {
    const changed = ledger.get(id) !== hash;
    newWrittenAt.set(id, changed ? atMs : ledgerWrittenAt.get(id) ?? 0);
  }

  const manifestOut: CatalogManifest = {
    model: effectivePin.model,
    dimension: effectivePin.dimension,
    purpose: effectivePin.purpose as CatalogManifest["purpose"],
    products: newLedger.size,
    at: at.toISOString(),
    ceiling,
  };
  await writeManifestAndAudit(
    { store },
    tenantId,
    manifestOut,
    { products: plan.length, embedded: toEmbed.length, written: vectorRecords.length, removed: stale.length, reindex: false, repaired: false },
    { entries: newLedger, priorChunkKeys, writtenAt: newWrittenAt },
    { actor: CATALOG_BACKFILL_ACTOR, action: "catalog_backfill.embed" },
  );

  return { embedded: toEmbed.length, written: vectorRecords.length, removed: stale.length };
}

/**
 * Task 11 (F5) — a private sentinel thrown when `shouldAbort()` reports true. Caught only inside
 * `runCatalogBackfill`, which turns it into a clean `{ outcome: "halted" }` report (never surfaced to a
 * caller as a generic failure, and never confused with a real `FAILED`/`CANCELED` bulk-op error).
 */
class CatalogSyncAbortedSignal extends Error {}

/** Poll `pollBulk` until COMPLETED, throwing on FAILED/CANCELED or attempt exhaustion — never an infinite
 *  loop (mirrors `ShopifyThrottleError`'s bounded-attempts discipline in shopify-client.ts). Re-checks
 *  `shouldAbort` (Task 11, F5) at the START of every attempt — before the very first poll, and again
 *  before each subsequent one — so a kill armed mid-run is honored between poll steps rather than only at
 *  entry, throwing `CatalogSyncAbortedSignal` instead of polling further. */
async function pollUntilComplete(
  client: ShopifyAdminClient,
  id: string,
  opts: {
    sleep: (ms: number) => Promise<void>;
    pollIntervalMs: number;
    maxPolls: number;
    shouldAbort?: () => Promise<boolean>;
  },
): Promise<BulkStatus> {
  for (let attempt = 1; attempt <= opts.maxPolls; attempt++) {
    if (opts.shouldAbort && (await opts.shouldAbort())) throw new CatalogSyncAbortedSignal();
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
  // Task 11 (F5) — the sync-plane abort signal, checked up front too: no step (not even acquiring a
  // token) should run once a kill has already armed by the time this tenant's turn comes up in the
  // scheduler's bounded pool.
  if (opts.shouldAbort && (await opts.shouldAbort())) {
    return { tenantId, productCount: 0, truncated: false, outcome: "halted" };
  }

  const token = await deps.getFreshAdminToken(tenantId);
  const shopDomain = await deps.shopDomainOf(tenantId);
  const creds: ShopifyAdminCreds = { shopDomain, accessToken: token };
  const client = deps.createClient
    ? deps.createClient(creds)
    : createShopifyAdminClient({ creds, fetchFn: deps.fetchFn, sleep });

  // Task 3 (credential-enrollment-unification) — the store_profile half of the unified pipeline. A
  // separate, ordinary Admin call (see `fetchStoreProfile`'s doc comment for why this cannot come off the
  // Bulk Operations response), gated on `deps.storeProfile` being wired at all: absent, this makes NO
  // extra Admin round-trip (byte-identical to #439). Fail-safe — never aborts the catalog write below.
  if (deps.storeProfile) {
    const profile = await fetchStoreProfile(client, shopDomain);
    try {
      await deps.storeProfile.put(tenantId, profile);
      await deps.store.audit(
        { tenantId },
        {
          actor: CATALOG_BACKFILL_ACTOR,
          action: "store_profile.write",
          input: { tenantId, brandName: profile.brandName },
          decision: "upserted",
          reversalPath: `StoreProfilePort.deleteTenant erases tenant ${tenantId}'s profile; a future backfill run overwrites it`,
        },
      );
    } catch (e) {
      console.error(
        `[catalog-backfill] ALERT store_profile_upsert_failed tenant=${tenantId} error=${e instanceof Error ? e.constructor.name : typeof e} msg=${(e as Error).message}`,
      );
    }
  }

  const { id } = await client.runBulkQuery(PRODUCTS_BULK_QUERY);
  let status: BulkStatus;
  try {
    status = await pollUntilComplete(client, id, {
      sleep,
      pollIntervalMs: opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      maxPolls: opts.maxPolls ?? DEFAULT_MAX_POLLS,
      shouldAbort: opts.shouldAbort,
    });
  } catch (e) {
    // Task 11 (F5) — a kill armed BETWEEN poll steps: report a clean halt, not a generic failure. Nothing
    // has been written yet (the bulk operation itself keeps running Shopify-side, unaffected — this job
    // simply stops WATCHING it and writes nothing on a deleted/killed token).
    if (e instanceof CatalogSyncAbortedSignal) {
      return { tenantId, productCount: 0, truncated: false, outcome: "halted" };
    }
    throw e;
  }

  // Task 11 (F5) — re-checked once more before spending the download/parse/write steps: a kill armed
  // during the (potentially long) poll loop's LAST iteration, right as it completed, must still stop the
  // job before any token-authenticated download or any store write happens.
  if (opts.shouldAbort && (await opts.shouldAbort())) {
    return { tenantId, productCount: 0, truncated: false, outcome: "halted" };
  }

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

  // Task 11 (F5) — the LAST checkpoint before any store write: a kill that armed during download/parsing
  // must still stop this tenant before `catalog_product`/`product_facts` are touched at all.
  if (opts.shouldAbort && (await opts.shouldAbort())) {
    return { tenantId, productCount: 0, truncated: false, outcome: "halted" };
  }

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

  // Task 3 (credential-enrollment-unification) — the pgvector embedding-corpus half of the unified
  // pipeline. Gated on BOTH `model` and `vector` being wired (absent ⇒ byte-identical to #439). Runs over
  // the FULL `records` set (not `toWrite`) because the embedding-corpus change detector is its OWN
  // content hash over embed text (title+tags+description, `embedTextFor`/`productEmbedText`) — a
  // different signal from `toWrite`'s rich-record hash (which also changes on a price/variant edit that
  // never touches the embedded text) — so a re-run against an unchanged catalog embeds zero regardless of
  // whether `records` is empty or not.
  if (deps.model && deps.vector && records.length > 0) {
    if (opts.shouldAbort && (await opts.shouldAbort())) {
      return { tenantId, productCount: 0, truncated: false, outcome: "halted" };
    }
    await syncEmbeddingCorpus(deps.store, deps.model, deps.vector, tenantId, records, at, maxProducts);
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

/**
 * Final-review fix (whole-branch review, 2026-08-23) — the MULTI-TENANT composition wrapper
 * `server.ts` actually wires as `CatalogIndexDeps.catalogProductAdminSource`. `makeCatalogProductByIdSource`
 * above is bound to ONE already-authenticated `ShopifyAdminClient`; this server runs many tenants behind
 * one process, so something has to resolve, per call, WHICH tenant's shop domain and admin token to build
 * that client from. This is that something, and it is what Task 13 left unbuilt: Task 13 wired
 * `reconcileDeps.catalogProduct` (the delta WRITE plane) but never constructed or wired
 * `catalogProductAdminSource` at all, so every delta write took the thin-projection fallback — silently
 * reintroducing the exact clobber Task 6/7 resolved, the moment a real Bulk-Ops backfill (Task 7, also
 * still unwired) ever populates a rich row.
 *
 * READ-ONLY, NO REFRESH — deliberately. `runCatalogBackfill`'s `getFreshAdminToken` (this file) exists
 * because a whole-catalog Bulk Operation can outlive a token's remaining life; a single by-id lookup here
 * cannot, and — separately — there is nothing to refresh yet: `InstallGrant.expiresAt`
 * (shopify-install-identity.ts) is ALWAYS `undefined` today, because `exchangeInstallCode` requests the
 * default, non-expiring OFFLINE token and Shopify's response for that grant carries no `expires_in` to
 * parse (see that file's own doc comment on `InstallGrant.expiresAt`). So the ONLY admin token this store
 * ever custodies today cannot expire, and a live-refresh/OAuth-rotation path (F9) is a SEPARATE, still-
 * deferred capability this function does not fabricate — it reads whatever is already custodied and
 * refuses (see below) rather than pretend to refresh anything.
 *
 * PER-TENANT OUTCOMES, and why each is honest rather than a guess:
 *   • no configured shop domain for this tenant           → `undefined` (no rich source; same as absent)
 *   • `AdminTokenStore.read` reports `"missing"`           → `undefined`. A tenant with no custodied admin
 *     token has never been able to run `runCatalogBackfill` either (it needs the SAME token from the SAME
 *     store), so there is provably no rich row for the caller's thin fallback to clobber.
 *   • `AdminTokenStore.read` reports `"unreadable"`        → THROWS (never a silent `undefined`). Unlike
 *     `"missing"`, `"unreadable"` can mean a token that WORKED at backfill time (so a rich row may already
 *     exist) has since become undecryptable — collapsing that into `undefined` would make the delta path
 *     silently overwrite that rich row with a thin one, which is exactly the clobber this whole seam
 *     exists to prevent. Throwing lets `reconcileProducts`'s own try/catch (catalog-index.ts) alert and
 *     skip the write entirely, leaving the existing row untouched — mirrors `makeAdminTokenRefresher`'s own
 *     fail-closed-on-`unreadable` rule (admin-token-refresh.ts).
 *   • found + configured                                  → a real `nodes(ids:)` fetch via
 *     `makeCatalogProductByIdSource`, scoped to that tenant's shop.
 */
export function makeMultiTenantCatalogProductAdminSource(
  tokens: Pick<AdminTokenStore, "read">,
  domains: Record<string, string>,
  opts: { createClient?: (creds: ShopifyAdminCreds) => ShopifyAdminClient; now?: () => Date } = {},
): CatalogProductByIdSource {
  const createClient = opts.createClient ?? ((creds: ShopifyAdminCreds) => createShopifyAdminClient({ creds }));
  return async (tenantId, ids) => {
    if (!Object.hasOwn(domains, tenantId)) return undefined;
    const shopDomain = domains[tenantId]!;
    const tokenRead = await tokens.read(tenantId);
    if (tokenRead.status === "missing") return undefined;
    if (tokenRead.status === "unreadable") {
      throw new Error(
        `admin token unreadable for tenant "${tenantId}" (${tokenRead.reason}) — refusing to silently fall ` +
          "back to a thin catalog_product write, which could clobber a rich row a prior (readable-token) " +
          "backfill already wrote; reinstall/re-custody the Admin token to restore the rich delta path",
      );
    }
    const client = createClient({ shopDomain, accessToken: tokenRead.token });
    return makeCatalogProductByIdSource(client, opts.now)(tenantId, ids);
  };
}
