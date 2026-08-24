import { describe, it, expect, vi } from "vitest";
import {
  InMemoryRuntimeStore,
  createInMemoryCatalogProductStore,
  createInMemoryProductFactsStore,
  type CatalogProductRecord,
} from "@palup/platform-ports";
import type { ShopifyAdminClient, BulkStatus } from "../src/shopify-client.js";
import { runCatalogBackfill, makeMultiTenantCatalogProductAdminSource, type CatalogBackfillDeps } from "../src/jobs/catalog-backfill.js";
import { reconcileProducts, type CatalogIndexDeps, type CatalogSource } from "../src/jobs/catalog-index.js";

// Task 7 (durable-catalog-sync) — the Bulk-Operations backfill driver, plus the load-bearing clobber
// resolution carried in from the Task 6 review: a rich backfill row must survive a subsequent thin delta
// write. See task-7-brief.md.
//
// The bulk-JSONL fixtures below assume Bulk Operations flattens nested connections (variants, images)
// into separate JSONL lines joined by `__parentId`, referencing the parent Product's `id`. This shape is
// NOT LIVE-VERIFIED against a real Shopify bulk export (task-7-brief.md's "Implementation note" / spec
// §13.3) — it is pinned conservatively against Shopify's documented bulk-operations behavior and these
// self-authored fixtures, and must be confirmed against a live bulk run before this parser is trusted in
// production.

const ALPHA_LINES = [
  JSON.stringify({
    id: "gid://shopify/Product/1",
    handle: "alpha-serum",
    title: "Alpha Serum",
    descriptionHtml: "<p>Great <b>serum</b></p>",
    status: "ACTIVE",
    productType: "Serum",
    vendor: "Acme",
    tags: ["hydrating", "vegan"],
    onlineStoreUrl: "https://acme.myshopify.com/products/alpha-serum",
    options: [{ name: "Size", values: ["30ml", "50ml"] }],
  }),
  JSON.stringify({
    id: "gid://shopify/ProductVariant/10",
    __parentId: "gid://shopify/Product/1",
    title: "30ml",
    sku: "ALPHA-30",
    price: "19.99",
    availableForSale: true,
    image: { url: "https://cdn.shopify.com/v10.jpg" },
    selectedOptions: [{ name: "Size", value: "30ml" }],
  }),
  JSON.stringify({
    id: "gid://shopify/ProductVariant/11",
    __parentId: "gid://shopify/Product/1",
    title: "50ml",
    sku: "ALPHA-50",
    price: "29.99",
    availableForSale: false,
    selectedOptions: [{ name: "Size", value: "50ml" }],
  }),
  JSON.stringify({
    id: "gid://shopify/ProductImage/100",
    __parentId: "gid://shopify/Product/1",
    url: "https://cdn.shopify.com/img1.jpg",
  }),
];

const BETA_LINES = [
  JSON.stringify({
    id: "gid://shopify/Product/2",
    handle: "beta-cream",
    title: "Beta Cream",
    status: "ACTIVE",
    tags: [],
  }),
  JSON.stringify({
    id: "gid://shopify/ProductVariant/20",
    __parentId: "gid://shopify/Product/2",
    price: "9.99",
    availableForSale: true,
  }),
];

const TWO_PRODUCT_JSONL = [...ALPHA_LINES, ...BETA_LINES].join("\n") + "\n";

/** A minimal fake ShopifyAdminClient — Task 3's client is exercised in shopify-client.test.ts already;
 *  this test only cares about how the backfill driver consumes runBulkQuery/pollBulk/downloadJsonl. */
function fakeClient(jsonl: string, opts: { pollsUntilDone?: number } = {}): ShopifyAdminClient {
  let polls = 0;
  const pollsUntilDone = opts.pollsUntilDone ?? 1;
  return {
    graphql: vi.fn(),
    runBulkQuery: vi.fn(async () => ({ id: "gid://shopify/BulkOperation/1" })),
    pollBulk: vi.fn(async (): Promise<BulkStatus> => {
      polls++;
      if (polls < pollsUntilDone) return { status: "RUNNING" };
      return { status: "COMPLETED", url: "https://storage.googleapis.com/bucket/result.jsonl", objectCount: 6 };
    }),
    downloadJsonl: vi.fn(async () => jsonl),
  };
}

function makeDeps(client: ShopifyAdminClient, overrides: Partial<CatalogBackfillDeps> = {}): CatalogBackfillDeps {
  return {
    store: new InMemoryRuntimeStore(),
    catalogProduct: createInMemoryCatalogProductStore(),
    productFacts: createInMemoryProductFactsStore(),
    getFreshAdminToken: vi.fn(async () => "admin-tok"),
    shopDomainOf: vi.fn(async () => "acme.myshopify.com"),
    createClient: () => client,
    sleep: async () => {},
    ...overrides,
  };
}

describe("runCatalogBackfill — loads Bulk JSONL into catalog_product + product_facts", () => {
  it("loads 2 products from the bulk JSONL into catalog_product and product_facts; a re-run with unchanged hashes is a no-op", async () => {
    const client = fakeClient(TWO_PRODUCT_JSONL);
    const deps = makeDeps(client);

    const r1 = await runCatalogBackfill(deps, "acme");
    expect(r1.tenantId).toBe("acme");
    expect(r1.productCount).toBe(2);
    expect(r1.truncated).toBe(false);
    expect(r1.outcome).toBe("backfilled");

    const rows = await deps.catalogProduct.getMany("acme", ["gid://shopify/Product/1", "gid://shopify/Product/2"]);
    expect(rows).toHaveLength(2);
    const alpha = rows.find((r) => r.productId === "gid://shopify/Product/1")!;
    expect(alpha.title).toBe("Alpha Serum");
    expect(alpha.handle).toBe("alpha-serum");
    expect(alpha.productType).toBe("Serum");
    expect(alpha.vendor).toBe("Acme");
    expect(alpha.tags).toEqual(["hydrating", "vegan"]);
    expect(alpha.status).toBe("active");
    expect(alpha.variants).toHaveLength(2);
    expect(alpha.variants.map((v) => v.sku).sort()).toEqual(["ALPHA-30", "ALPHA-50"]);
    expect(alpha.variants.find((v) => v.sku === "ALPHA-30")!.availableForSale).toBe(true);
    expect(alpha.variants.find((v) => v.sku === "ALPHA-50")!.availableForSale).toBe(false);
    expect(alpha.imageUrls).toEqual(["https://cdn.shopify.com/img1.jpg"]);
    expect(alpha.onlineStoreUrl).toBe("https://acme.myshopify.com/products/alpha-serum");
    // F8: availableForSale is carried as a boolean only — no raw stock/quantity field anywhere.
    for (const v of alpha.variants) {
      expect(v).not.toHaveProperty("inventoryQuantity");
      expect(v).not.toHaveProperty("quantityAvailable");
    }

    const facts = await deps.productFacts!.getMany("acme", ["gid://shopify/Product/1", "gid://shopify/Product/2"]);
    expect(facts).toHaveLength(2);

    // ── re-run: unchanged hashes ⇒ zero rewrites ──
    const upsertSpy = vi.spyOn(deps.catalogProduct, "upsertMany");
    const factsUpsertSpy = vi.spyOn(deps.productFacts!, "upsertMany");
    const client2 = fakeClient(TWO_PRODUCT_JSONL);
    const r2 = await runCatalogBackfill({ ...deps, createClient: () => client2 }, "acme");
    expect(r2.outcome).toBe("unchanged");
    expect(r2.productCount).toBe(2);
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(factsUpsertSpy).not.toHaveBeenCalled();
  });

  it("sets truncated + logs/audits when the catalog exceeds the ceiling (no silent cap)", async () => {
    const client = fakeClient(TWO_PRODUCT_JSONL);
    const deps = makeDeps(client);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const r = await runCatalogBackfill(deps, "acme", { maxProducts: 1 });
    expect(r.truncated).toBe(true);
    expect(r.productCount).toBe(1); // truncated to the ceiling, not refused wholesale
    expect(r.outcome).toBe("backfilled");

    const rows = await deps.catalogProduct.listByTenant("acme");
    expect(rows).toHaveLength(1);

    expect(errorSpy).toHaveBeenCalled();
    const auditLog = await deps.store.readAudit({ tenantId: "acme" });
    const truncatedEntry = auditLog.find(
      (a) => a.action === "catalog_backfill.run" && (a.input as { truncated?: boolean })?.truncated === true,
    );
    expect(truncatedEntry).toBeDefined();

    errorSpy.mockRestore();
  });
});

describe("clobber preservation (load-bearing, carried in from Task 6 review)", () => {
  it("a delta reconcile after a rich backfill does NOT clobber the rich fields (variants/description/tags survive)", async () => {
    const client = fakeClient(TWO_PRODUCT_JSONL);
    const backfillDeps = makeDeps(client);

    await runCatalogBackfill(backfillDeps, "acme");
    const before = (await backfillDeps.catalogProduct.getMany("acme", ["gid://shopify/Product/1"]))[0]!;
    expect(before.variants).toHaveLength(2);
    expect(before.descriptionText).toContain("serum");
    expect(before.tags).toEqual(["hydrating", "vegan"]);

    // Now simulate the delta path: a product webhook fires and reconcileProducts runs a TARGETED update
    // for gid.../1. Without the clobber fix, reconcileProducts would rebuild a THIN CatalogProductRecord
    // from the Storefront-shaped Product (one flat variant, no description/tags) and null out everything
    // this backfill just wrote. With the fix (`catalogProductAdminSource`), reconcileProducts fetches the
    // FULL Admin shape for the changed id and writes THAT instead.
    const store = backfillDeps.store;
    const vector = (await import("@palup/platform-ports")).createInMemoryVectorStore();
    const model = (await import("@palup/platform-ports")).requireEmbedInputs
      ? {
          async complete() {
            return { text: "ok", model: "fake" };
          },
          async embed(req: { texts: string[]; purpose: "document" | "query" }) {
            return { vectors: req.texts.map(() => [0, 0, 0, 0]), model: "fake-embed", dimension: 4, purpose: req.purpose };
          },
        }
      : undefined;

    // Seed a manifest so reconcileProducts takes the TARGETED path (it requires an existing manifest +
    // catalogById + valid ids, else it falls back to a full crawl).
    const thinCatalog: CatalogSource = async (t) => ({
      tenantId: t,
      brandName: "Acme",
      products: [
        {
          id: "gid://shopify/Product/1",
          title: "Alpha Serum",
          description: "Great serum",
          price: "$19.99",
        },
      ],
      policy: { returns: "", shipping: "" },
    });
    const seedDeps: CatalogIndexDeps = { store, vector, model: model as any, catalog: thinCatalog };
    await (await import("../src/jobs/catalog-index.js")).runCatalogIndex(seedDeps, ["acme"]);

    // The THIN by-id source a webhook-driven reconcile would normally use — deliberately impoverished
    // (single variant, no description/tags) to prove the clobber would happen WITHOUT the fix.
    const thinCatalogById = async (_t: string, ids: string[]) =>
      [
        {
          id: "gid://shopify/Product/1",
          title: "Alpha Serum",
          description: "Great serum",
          price: "$24.99", // price changed — this is what triggered the webhook
          tags: undefined,
        },
      ].filter((p) => ids.includes(p.id));

    // The RICH Admin-shape by-id source (the clobber fix's seam) — returns the SAME rich shape the
    // backfill itself produced. A real composition (Task 13) would back this with a live Admin GraphQL
    // `nodes(ids:)` call via the Task 3 client; here it is a fake returning the already-known rich record.
    const catalogProductAdminSource = async (_t: string, ids: string[]) =>
      (await backfillDeps.catalogProduct.getMany("acme", ids)).map((r) => ({ ...r, syncedAt: new Date().toISOString() }));

    const reconcileDeps: CatalogIndexDeps = {
      store,
      vector,
      model: model as any,
      catalog: thinCatalog,
      catalogById: thinCatalogById,
      catalogProduct: backfillDeps.catalogProduct,
      catalogProductAdminSource,
    };

    const r = await reconcileProducts(reconcileDeps, "acme", ["gid://shopify/Product/1"], { reason: "product" });
    expect(r.outcome).toBe("indexed");

    const after = (await backfillDeps.catalogProduct.getMany("acme", ["gid://shopify/Product/1"]))[0]!;
    expect(after.variants).toHaveLength(2); // NOT clobbered down to 1 thin variant
    expect(after.descriptionText).toContain("serum");
    expect(after.tags).toEqual(["hydrating", "vegan"]);
    expect(after.productType).toBe("Serum");
    expect(after.vendor).toBe("Acme");
  });

  it("without the admin source (byte-identical Task 6 default), a delta DOES fall back to the thin write", async () => {
    const client = fakeClient(TWO_PRODUCT_JSONL);
    const backfillDeps = makeDeps(client);
    await runCatalogBackfill(backfillDeps, "acme");

    const store = backfillDeps.store;
    const { createInMemoryVectorStore } = await import("@palup/platform-ports");
    const vector = createInMemoryVectorStore();
    const model = {
      async complete() {
        return { text: "ok", model: "fake" };
      },
      async embed(req: { texts: string[]; purpose: "document" | "query" }) {
        return { vectors: req.texts.map(() => [0, 0, 0, 0]), model: "fake-embed", dimension: 4, purpose: req.purpose };
      },
    };
    const thinCatalog: CatalogSource = async (t) => ({
      tenantId: t,
      brandName: "Acme",
      products: [{ id: "gid://shopify/Product/1", title: "Alpha Serum", description: "Great serum", price: "$19.99" }],
      policy: { returns: "", shipping: "" },
    });
    await (await import("../src/jobs/catalog-index.js")).runCatalogIndex(
      { store, vector, model: model as any, catalog: thinCatalog },
      ["acme"],
    );
    const thinCatalogById = async (_t: string, ids: string[]) =>
      [
        {
          id: "gid://shopify/Product/1",
          title: "Alpha Serum",
          description: "Great serum",
          price: "$24.99",
          variantId: "gid://shopify/Product/1/variant/1",
        },
      ].filter((p) => ids.includes(p.id));

    const reconcileDeps: CatalogIndexDeps = {
      store,
      vector,
      model: model as any,
      catalog: thinCatalog,
      catalogById: thinCatalogById,
      catalogProduct: backfillDeps.catalogProduct,
      // NO catalogProductAdminSource — default composition, exactly Task 6's shape.
    };
    await reconcileProducts(reconcileDeps, "acme", ["gid://shopify/Product/1"], { reason: "product" });

    const after = (await backfillDeps.catalogProduct.getMany("acme", ["gid://shopify/Product/1"]))[0]!;
    expect(after.variants).toHaveLength(1); // thin projection — confirms the seam is opt-in, not a silent behavior change
  });

  it("a mixed batch [live id, delisted id] does NOT resurrect the delisted id even when the admin source would return a record for it", async () => {
    // Review round-1 finding: the admin-source lookup used to be scoped to the FULL requested batch
    // (`validProductIds`), which can include an id THIS SAME reconcile call determines is stale/delisted
    // and is about to soft-delete. `makeCatalogProductByIdSource` filters only by GID shape, not publish
    // state — an unpublished-but-not-yet-pruned product can still come back from a `nodes(ids:)` call —
    // so a permissive admin source asked about a delisted id could hand back a live-looking record, and
    // the subsequent `upsertMany` would UN-TOMBSTONE a product this very call just soft-deleted. The fix
    // scopes the admin-source call to `fetched`'s ids (the ones `catalogById` just confirmed are still
    // live), never the raw requested batch.
    const client = fakeClient(TWO_PRODUCT_JSONL);
    const backfillDeps = makeDeps(client);
    await runCatalogBackfill(backfillDeps, "acme"); // rich rows for BOTH gid.../1 and gid.../2

    // An INDEPENDENT rich-record cache — standing in for "what Shopify's Admin API would still return for
    // these GIDs today," which is deliberately NOT derived from `catalogProduct`'s own tombstone state
    // (the whole point: Admin doesn't know or care about OUR soft-delete bookkeeping). Seeded from the
    // backfill's own output before any reconcile runs.
    const adminRichRecords = new Map(
      (await backfillDeps.catalogProduct.getMany("acme", ["gid://shopify/Product/1", "gid://shopify/Product/2"])).map(
        (r) => [r.productId, r],
      ),
    );
    // Deliberately PERMISSIVE — returns a record for ANY id it's asked about, proving the scoping fix (not
    // the source's own judgment) is what keeps a delisted id from being resurrected.
    const catalogProductAdminSource = vi.fn(async (_t: string, ids: string[]) =>
      ids.map((id) => adminRichRecords.get(id)).filter((r): r is CatalogProductRecord => r !== undefined),
    );

    const store = backfillDeps.store;
    const { createInMemoryVectorStore } = await import("@palup/platform-ports");
    const vector = createInMemoryVectorStore();
    const model = {
      async complete() {
        return { text: "ok", model: "fake" };
      },
      async embed(req: { texts: string[]; purpose: "document" | "query" }) {
        return { vectors: req.texts.map(() => [0, 0, 0, 0]), model: "fake-embed", dimension: 4, purpose: req.purpose };
      },
    };
    // Seed a manifest covering BOTH ids, so the ledger knows about gid.../2 and can detect it as stale
    // when a later fetch no longer returns it.
    const thinCatalog: CatalogSource = async (t) => ({
      tenantId: t,
      brandName: "Acme",
      products: [
        { id: "gid://shopify/Product/1", title: "Alpha Serum", description: "Great serum", price: "$19.99" },
        { id: "gid://shopify/Product/2", title: "Beta Cream", description: "Beta cream description", price: "$9.99" },
      ],
      policy: { returns: "", shipping: "" },
    });
    await (await import("../src/jobs/catalog-index.js")).runCatalogIndex(
      { store, vector, model: model as any, catalog: thinCatalog },
      ["acme"],
    );

    // The webhook batch names BOTH ids, but the thin by-id fetch (what a real product-delete webhook
    // reconcile would see) only confirms gid.../1 is still live — gid.../2 is delisted.
    const thinCatalogById = async (_t: string, ids: string[]) =>
      [{ id: "gid://shopify/Product/1", title: "Alpha Serum", description: "Great serum", price: "$24.99" }].filter(
        (p) => ids.includes(p.id),
      );

    const reconcileDeps: CatalogIndexDeps = {
      store,
      vector,
      model: model as any,
      catalog: thinCatalog,
      catalogById: thinCatalogById,
      catalogProduct: backfillDeps.catalogProduct,
      catalogProductAdminSource,
    };

    const r = await reconcileProducts(
      reconcileDeps,
      "acme",
      ["gid://shopify/Product/1", "gid://shopify/Product/2"],
      { reason: "product" },
    );
    expect(r.outcome).toBe("indexed");

    // The delisted id must be tombstoned, NOT resurrected by the permissive admin source.
    expect(await backfillDeps.catalogProduct.getMany("acme", ["gid://shopify/Product/2"])).toEqual([]);

    // The still-live id keeps getting the rich update.
    const alpha = (await backfillDeps.catalogProduct.getMany("acme", ["gid://shopify/Product/1"]))[0]!;
    expect(alpha.variants).toHaveLength(2);

    // Pin the actual fix, not just the end state: the admin source must never even be ASKED about the
    // delisted id.
    for (const call of catalogProductAdminSource.mock.calls) {
      expect(call[1]).not.toContain("gid://shopify/Product/2");
    }
  });
});

// Final-review fix (whole-branch review, 2026-08-23) — Task 13 wired `reconcileDeps.catalogProduct` into
// server.ts's composition but never constructed or wired `catalogProductAdminSource`, so every real delta
// write would have taken the thin-projection fallback exercised above ("without the admin source...").
// `makeMultiTenantCatalogProductAdminSource` is the per-tenant wrapper server.ts now composes as that
// field, resolving which tenant's shop domain + custodied admin token to build a `ShopifyAdminClient` from
// before delegating to `makeCatalogProductByIdSource`.
describe("makeMultiTenantCatalogProductAdminSource (final-review fix) — the per-tenant seam server.ts composes as catalogProductAdminSource", () => {
  const DOMAINS = { acme: "acme.myshopify.com" };

  function fakeGraphqlClient(nodes: unknown[]): ShopifyAdminClient {
    return {
      graphql: vi.fn(async () => ({ data: { nodes } })),
      runBulkQuery: vi.fn(),
      pollBulk: vi.fn(),
      downloadJsonl: vi.fn(),
    } as unknown as ShopifyAdminClient;
  }

  it("found token + configured domain: builds a client from the tenant's own creds and returns the real rich record", async () => {
    const client = fakeGraphqlClient([
      {
        id: "gid://shopify/Product/1",
        handle: "alpha-serum",
        title: "Alpha Serum",
        descriptionHtml: "<p>Great serum</p>",
        status: "ACTIVE",
        tags: ["hydrating", "vegan"],
      },
    ]);
    const tokens = { read: vi.fn(async () => ({ status: "found" as const, token: "admin-tok-acme" })) };
    const createClient = vi.fn(() => client);

    const source = makeMultiTenantCatalogProductAdminSource(tokens, DOMAINS, { createClient });
    const records = await source("acme", ["gid://shopify/Product/1"]);

    expect(createClient).toHaveBeenCalledWith({ shopDomain: "acme.myshopify.com", accessToken: "admin-tok-acme" });
    expect(records).toHaveLength(1);
    expect(records![0]!.title).toBe("Alpha Serum");
    expect(records![0]!.tags).toEqual(["hydrating", "vegan"]);
    expect(records![0]!.descriptionText).toContain("serum");
  });

  it("no configured shop domain for this tenant: returns undefined without ever reading the token store", async () => {
    const tokens = { read: vi.fn(async () => ({ status: "found" as const, token: "x" })) };
    const source = makeMultiTenantCatalogProductAdminSource(tokens, {}, {});

    expect(await source("acme", ["gid://shopify/Product/1"])).toBeUndefined();
    expect(tokens.read).not.toHaveBeenCalled();
  });

  it('admin token "missing": returns undefined (no rich source) — safe, because a tenant with no custodied token could never have run a backfill to produce a rich row either', async () => {
    const tokens = { read: vi.fn(async () => ({ status: "missing" as const })) };
    const source = makeMultiTenantCatalogProductAdminSource(tokens, DOMAINS, {});

    expect(await source("acme", ["gid://shopify/Product/1"])).toBeUndefined();
  });

  it('admin token "unreadable": THROWS rather than silently falling back — an unreadable token might have worked at backfill time, so silently returning undefined here could let the delta path clobber an existing rich row', async () => {
    const tokens = { read: vi.fn(async () => ({ status: "unreadable" as const, reason: "undecryptable" as const })) };
    const source = makeMultiTenantCatalogProductAdminSource(tokens, DOMAINS, {});

    await expect(source("acme", ["gid://shopify/Product/1"])).rejects.toThrow(/unreadable/i);
  });
});
