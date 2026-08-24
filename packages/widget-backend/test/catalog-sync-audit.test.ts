import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  InMemoryRuntimeStore,
  createAesGcmCrypto,
  createEnvSecrets,
  keyScopeSecretName,
  createInMemoryVectorStore,
  createInMemoryCatalogProductStore,
  createInMemoryProductFactsStore,
  requireEmbedInputs,
  type EmbedRequest,
  type EmbedResponse,
  type GroundingContext,
  type ModelPort,
  type Product,
} from "@palup/platform-ports";
import { createAdminTokenStore, ADMIN_CRED_KEY_SCOPE } from "@palup/state-postgres";
import { runCatalogIndex, reconcileProducts, type CatalogSource, type CatalogByIdSource, type CatalogIndexDeps } from "../src/jobs/catalog-index.js";
import { runCatalogBackfill, type CatalogBackfillDeps } from "../src/jobs/catalog-backfill.js";
import type { ShopifyAdminClient, BulkStatus } from "../src/shopify-client.js";

// Task 12 (ADR-0022 F3 / NN#5) — audit-completeness for the durable-catalog-sync feature. Tasks 4/6/7/9
// each added an audited write for one piece of the catalog-sync surface (Admin-token custody, the
// catalog_product durable store, the Bulk-Operations backfill). This file is the SINGLE place that pins
// every one of those action strings against the in-memory store's real audit log — not by re-deriving new
// audit calls (NN#5's rule here is "pin what exists", not "invent something to pin") but by exercising each
// call site through its real public entry point and reading `RuntimeStatePort.readAudit` back, exactly like
// admin-token-store.test.ts (`readAudits`) and catalog-backfill.test.ts's own truncation assertion do.
//
// The action strings below are copied from, and verified against, these exact call sites:
//   admin_token.store    — packages/state-postgres/src/admin-token-store.ts:175 (`writeAndAudit`, `put`)
//   admin_token.refresh  — packages/state-postgres/src/admin-token-store.ts:179 (`writeAndAudit`, `refresh`)
//   admin_token.delete   — packages/state-postgres/src/admin-token-store.ts:202 (`delete`)
//   catalog_product.write (decision "upserted")    — jobs/catalog-index.ts:666 (indexOneTenant) and :1302
//                                                     (reconcileProducts)
//   catalog_product.write (decision "soft_deleted", i.e. the TOMBSTONE) — jobs/catalog-index.ts:902
//                                                     (indexOneTenant prune) and :1220 (reconcileProducts)
//   catalog_backfill.run (input.truncated === true) — jobs/catalog-backfill.ts:609
//
// The four `*_failed` best-effort-audit variants this task's brief also names
// (`admin_token.delete_failed`, `catalog_product.tombstone_failed`, `catalog_product.delete_tenant_failed`)
// are ALREADY exercised end-to-end (via `app.inject` against the uninstall webhook) in
// `shopify-webhooks-admin-token.test.ts` (Task 9) — re-deriving a second live harness for the same failure
// paths here would be duplication, not additional coverage. This file instead pins their SOURCE STRINGS
// with the same grep-based technique `order-attribution-scope-pinning.test.ts` already uses to pin
// `shopify.app.toml`'s scopes line, so a rename/typo of any of them is still caught here even if the
// webhook-level test's own assertion were ever loosened.

function fakeModel(dimension = 4, model = "fake-embed-4d"): ModelPort {
  return {
    async complete() {
      return { text: "ok", model };
    },
    async embed(req: EmbedRequest): Promise<EmbedResponse> {
      requireEmbedInputs(req);
      const vectors = req.texts.map((t) => {
        const v = new Array(dimension).fill(0);
        for (let i = 0; i < t.length; i++) v[i % dimension] += t.charCodeAt(i) % 7;
        return v;
      });
      return { vectors, model, dimension, purpose: req.purpose };
    },
  };
}

const P = (id: string, title: string): Product => ({
  id,
  title,
  description: `${title} description`,
  price: "$10",
  tags: [title, "tag2"],
  availableForSale: true,
  handle: title.toLowerCase(),
  variantId: `${id}/variant/1`,
  imageUrl: "https://cdn.shopify.com/img.jpg",
});
const A = P("gid://shopify/Product/1", "alpha");
const B = P("gid://shopify/Product/2", "beta");

const fullCatalog =
  (ps: Product[]): CatalogSource =>
  async (t): Promise<GroundingContext> => ({
    tenantId: t,
    brandName: "Acme",
    products: ps,
    policy: { returns: "", shipping: "" },
  });

describe("Task 12 (NN#5) — catalog-sync audit completeness", () => {
  it("admin_token.store, admin_token.refresh and admin_token.delete each emit an audit entry", async () => {
    const store = new InMemoryRuntimeStore();
    const adminKeyName = keyScopeSecretName("MEMORY_ENCRYPTION_KEY", ADMIN_CRED_KEY_SCOPE);
    const crypto = createAesGcmCrypto(createEnvSecrets(JSON.stringify({ acme: { [adminKeyName]: "admin-cred-material" } })));
    const tokens = createAdminTokenStore(store, crypto);

    await tokens.put("acme", "shpat_first", { actor: "system:test" });
    await tokens.refresh("acme", { token: "shpat_second" }, { actor: "system:test" });
    await tokens.delete("acme", { actor: "system:test" });

    const log = await store.readAudit({ tenantId: "acme" });
    expect(log.some((a) => a.action === "admin_token.store")).toBe(true);
    expect(log.some((a) => a.action === "admin_token.refresh")).toBe(true);
    expect(log.some((a) => a.action === "admin_token.delete")).toBe(true);
  });

  it("catalog_product.write emits an audit entry on upsert (full-crawl path)", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const model = fakeModel();
    const catalogProduct = createInMemoryCatalogProductStore();

    await runCatalogIndex({ store, vector, model, catalog: fullCatalog([A, B]), catalogProduct }, ["acme"]);

    const log = await store.readAudit({ tenantId: "acme" });
    const upsertEntry = log.find(
      (a) => a.action === "catalog_product.write" && (a.decision as string) === "upserted",
    );
    expect(upsertEntry, "expected a catalog_product.write / upserted audit entry").toBeDefined();
  });

  it("catalog_product.write emits an audit entry on tombstone (soft-delete of a delisted product)", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const model = fakeModel();
    const catalogProduct = createInMemoryCatalogProductStore();
    const deps: CatalogIndexDeps = { store, vector, model, catalog: fullCatalog([A, B]), catalogProduct };

    // Seed a manifest via a full index first, so reconcileProducts takes the TARGETED path.
    await runCatalogIndex(deps, ["acme"]);

    // gid .../1 (A) still resolves; gid .../2 (B) no longer does — a delisted product.
    const catalogById: CatalogByIdSource = async (_t, ids) => [A].filter((p) => ids.includes(p.id));
    const r = await reconcileProducts({ ...deps, catalogById }, "acme", [A.id, B.id], { reason: "product" });
    expect(r.outcome).toBe("indexed");

    const log = await store.readAudit({ tenantId: "acme" });
    const tombstoneEntry = log.find(
      (a) => a.action === "catalog_product.write" && (a.decision as string) === "soft_deleted",
    );
    expect(tombstoneEntry, "expected a catalog_product.write / soft_deleted (tombstone) audit entry").toBeDefined();
  });

  it("catalog_backfill.run emits a truncation audit entry when the catalog exceeds the ceiling", async () => {
    const TWO_PRODUCT_JSONL =
      [
        JSON.stringify({ id: "gid://shopify/Product/1", handle: "alpha", title: "Alpha", status: "ACTIVE", tags: [] }),
        JSON.stringify({ id: "gid://shopify/ProductVariant/10", __parentId: "gid://shopify/Product/1", price: "9.99", availableForSale: true }),
        JSON.stringify({ id: "gid://shopify/Product/2", handle: "beta", title: "Beta", status: "ACTIVE", tags: [] }),
        JSON.stringify({ id: "gid://shopify/ProductVariant/20", __parentId: "gid://shopify/Product/2", price: "19.99", availableForSale: true }),
      ].join("\n") + "\n";

    function fakeClient(jsonl: string): ShopifyAdminClient {
      return {
        graphql: vi.fn(),
        runBulkQuery: vi.fn(async () => ({ id: "gid://shopify/BulkOperation/1" })),
        pollBulk: vi.fn(async (): Promise<BulkStatus> => ({ status: "COMPLETED", url: "https://storage.googleapis.com/bucket/result.jsonl", objectCount: 4 })),
        downloadJsonl: vi.fn(async () => jsonl),
      };
    }

    const store = new InMemoryRuntimeStore();
    const deps: CatalogBackfillDeps = {
      store,
      catalogProduct: createInMemoryCatalogProductStore(),
      productFacts: createInMemoryProductFactsStore(),
      getFreshAdminToken: vi.fn(async () => "admin-tok"),
      shopDomainOf: vi.fn(async () => "acme.myshopify.com"),
      createClient: () => fakeClient(TWO_PRODUCT_JSONL),
      sleep: async () => {},
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // maxProducts: 1 stands in for the >50k ceiling this constant defaults to (MAX_INDEXED_PRODUCTS) —
    // the same override catalog-backfill.test.ts uses to exercise truncation cheaply in a unit test.
    const r = await runCatalogBackfill(deps, "acme", { maxProducts: 1 });
    expect(r.truncated).toBe(true);

    const log = await store.readAudit({ tenantId: "acme" });
    const truncatedEntry = log.find(
      (a) => a.action === "catalog_backfill.run" && (a.input as { truncated?: boolean })?.truncated === true,
    );
    expect(truncatedEntry, "expected a catalog_backfill.run audit entry with input.truncated === true").toBeDefined();

    errorSpy.mockRestore();
  });

  it("the *_failed best-effort audit action strings (Task 9, exercised live in shopify-webhooks-admin-token.test.ts) still exist in source", () => {
    const webhooksSrc = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "routes", "shopify-webhooks.ts");
    const src = readFileSync(webhooksSrc, "utf8");
    for (const action of ["admin_token.delete_failed", "catalog_product.tombstone_failed", "catalog_product.delete_tenant_failed"]) {
      expect(src.includes(`action: "${action}"`), `expected shopify-webhooks.ts to still audit "${action}"`).toBe(true);
    }
  });
});
