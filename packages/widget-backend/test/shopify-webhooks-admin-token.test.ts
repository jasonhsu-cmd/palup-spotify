import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import Fastify from "fastify";
import {
  InMemoryRuntimeStore,
  createInMemoryMerchantRegistry,
  createInMemoryVectorStore,
  createInMemoryCatalogProductStore,
} from "@palup/platform-ports";
import type { CatalogProductPort, MerchantRegistryPort, RuntimeStatePort, VectorPort } from "@palup/platform-ports";
import type { AdminTokenStore } from "@palup/state-postgres";
import { registerShopifyWebhookRoutes, WEBHOOK_ROUTES, type ShopifyWebhookDeps } from "../src/routes/shopify-webhooks.js";

// Task 9 (ADR-0022 F1) — the two-step Admin-token + catalog teardown property:
//   `app/uninstalled` (shop from the UNSIGNED `X-Shopify-Shop-Domain` header, spoofable via replay) must
//   NEVER hard-delete the Admin token or hard-retire the catalog — only reversible actions (a status
//   write + a catalog_product TOMBSTONE) may run there.
//   `shop/redact` (shop from the HMAC-COVERED `shop_domain` body field) is the IRREVERSIBLE step — its
//   applied path hard-deletes the Admin token and hard-retires the catalog via `deleteTenant`. Its
//   kill-deferred path must NOT hard-delete either.

const SHOP = "acme-store.myshopify.com";
const TENANT = "acme-store";
const APP_SECRET = "app-client-secret-never-logged";
const EMBED_KEY = "pk_acme_embed_key";

function signBody(raw: string, secret = APP_SECRET): string {
  return createHmac("sha256", secret).update(raw, "utf8").digest("base64");
}

let webhookSeq = 0;
function nextWebhookId(): string {
  webhookSeq += 1;
  return `wh-admin-token-${webhookSeq}`;
}

function fakeAdminTokens(
  opts: { throwOnDelete?: boolean } = {},
): Pick<AdminTokenStore, "delete"> & { deleteCalls: Array<{ tenantId: string; opts: { actor: string } }> } {
  const deleteCalls: Array<{ tenantId: string; opts: { actor: string } }> = [];
  return {
    deleteCalls,
    async delete(tenantId, deleteOpts) {
      deleteCalls.push({ tenantId, opts: deleteOpts });
      if (opts.throwOnDelete) throw new Error("simulated admin token store failure");
    },
  };
}

/** Wraps a real CatalogProductPort but makes `deleteTenant` throw — for REVIEW-FIX RED evidence that a
 *  thrown hard-retire is caught and separately audited, never silently swallowed behind a 200. */
function throwingDeleteTenant(inner: CatalogProductPort): CatalogProductPort {
  return {
    ...inner,
    async deleteTenant() {
      throw new Error("simulated catalog_product store failure");
    },
  };
}

interface Harness {
  post: (path: string, topic: string, raw: string, opts?: { webhookId?: string; hmac?: string | null }) => Promise<{ statusCode: number; body: string }>;
  store: RuntimeStatePort;
  registry: MerchantRegistryPort;
  vector: VectorPort;
  adminTokens: ReturnType<typeof fakeAdminTokens>;
  catalogProduct: CatalogProductPort;
}

async function harness(
  opts: {
    killCheck?: (tenantId: string) => Promise<boolean>;
    withCatalogProduct?: boolean;
    withAdminTokens?: boolean;
    adminTokensThrowOnDelete?: boolean;
    catalogProductThrowOnDeleteTenant?: boolean;
  } = {},
): Promise<Harness> {
  const app = Fastify();
  const store = new InMemoryRuntimeStore();
  const registry = createInMemoryMerchantRegistry();
  const vector: VectorPort = createInMemoryVectorStore();
  const adminTokens = fakeAdminTokens({ throwOnDelete: opts.adminTokensThrowOnDelete });
  // The port exposed to test assertions (seeding, reading rows back) is always the REAL in-memory store;
  // `deps.catalogProduct` may instead be a throwing WRAPPER around it, so a simulated deleteTenant failure
  // never actually removes the seeded row underneath the assertions below.
  const catalogProduct = createInMemoryCatalogProductStore();
  const catalogProductDep = opts.catalogProductThrowOnDeleteTenant ? throwingDeleteTenant(catalogProduct) : catalogProduct;
  await registry.create({ tenantId: TENANT, shopDomain: SHOP, embedKey: EMBED_KEY, region: "us" });

  const deps: ShopifyWebhookDeps = {
    store,
    registry,
    vector,
    clientSecret: async () => APP_SECRET,
    killCheck: opts.killCheck ?? (async () => false),
    now: () => Date.now(),
    ...(opts.withAdminTokens === false ? {} : { adminTokens }),
    ...(opts.withCatalogProduct === false ? {} : { catalogProduct: catalogProductDep }),
  };
  registerShopifyWebhookRoutes(app, deps);
  await app.ready();

  const post = async (path: string, topic: string, raw: string, o: { webhookId?: string; hmac?: string | null } = {}) => {
    const res = await app.inject({
      method: "POST",
      url: path,
      headers: {
        "content-type": "application/json",
        "x-shopify-topic": topic,
        "x-shopify-api-version": "2026-07",
        "x-shopify-webhook-id": o.webhookId ?? nextWebhookId(),
        "x-shopify-shop-domain": SHOP,
        "x-shopify-hmac-sha256": o.hmac === null ? "" : (o.hmac ?? signBody(raw)),
      },
      payload: raw,
    });
    return { statusCode: res.statusCode, body: res.body };
  };

  return { post, store, registry, vector, adminTokens, catalogProduct };
}

const shopRedactBody = (): string => JSON.stringify({ shop_id: 954889, shop_domain: SHOP });
const appUninstalledBody = (): string => JSON.stringify({ id: 548380009, name: "Acme", domain: null, myshopify_domain: null, plan_name: "enterprise" });

async function seedProducts(catalogProduct: CatalogProductPort): Promise<void> {
  await catalogProduct.upsertMany(TENANT, [
    {
      productId: "gid://shopify/Product/1",
      handle: "p1",
      title: "Product 1",
      status: "active",
      variants: [],
      contentHash: "h1",
      syncedAt: new Date().toISOString(),
    },
  ]);
}

describe("Task 9 (ADR-0022 F1) — two-step Admin-token + catalog teardown", () => {
  it("app/uninstalled (header-sourced) does NOT delete the admin token (reversible only)", async () => {
    const h = await harness();
    await seedProducts(h.catalogProduct);

    const res = await h.post(WEBHOOK_ROUTES.appUninstalled, "app/uninstalled", appUninstalledBody());
    expect(res.statusCode).toBe(200);

    // F1: the Admin token must survive an app/uninstalled delivery no matter what.
    expect(h.adminTokens.deleteCalls).toHaveLength(0);

    // The status write is the one destructive-but-reversible thing this topic may do.
    const merchant = await h.registry.lookupByTenantId(TENANT, { includeInactive: true });
    expect(merchant?.status).toBe("uninstalled");

    // Reversible: the catalog_product rows are tombstoned (deletedAt set), not gone.
    expect(await h.catalogProduct.getMany(TENANT, ["gid://shopify/Product/1"])).toEqual([]);
    const withDeleted = await h.catalogProduct.listByTenant(TENANT, { includeDeleted: true });
    expect(withDeleted).toHaveLength(1);
    expect(withDeleted[0]?.deletedAt).toBeTruthy();
  });

  it("app/uninstalled: a spoofed/replayed header can never destroy an arbitrary tenant's admin token or hard-retire its catalog", async () => {
    // Even with a validly-HMAC'd body (the attacker cannot forge the HMAC without the secret, but the
    // shop identity for THIS topic comes from the header alone — see APP_UNINSTALLED_SHOP_SOURCE), the
    // worst this handler can do is make the named tenant inert and tombstone its catalog. It structurally
    // cannot reach adminTokens.delete or catalogProduct.deleteTenant.
    const h = await harness();
    await seedProducts(h.catalogProduct);

    await h.post(WEBHOOK_ROUTES.appUninstalled, "app/uninstalled", appUninstalledBody());

    expect(h.adminTokens.deleteCalls).toHaveLength(0);
    // deleteTenant would remove ALL rows including tombstoned ones from listByTenant({includeDeleted:true});
    // assert the tombstoned row is still enumerable, i.e. the tenant was never hard-retired.
    expect(await h.catalogProduct.listByTenant(TENANT, { includeDeleted: true })).toHaveLength(1);
  });

  it("app/uninstalled audits the tombstone as reversible and never mentions the admin token as erased", async () => {
    const h = await harness();
    await seedProducts(h.catalogProduct);

    await h.post(WEBHOOK_ROUTES.appUninstalled, "app/uninstalled", appUninstalledBody());

    const audit = await h.store.readAudit({ tenantId: TENANT });
    const rec = audit.find((r) => r.action === "merchant.uninstalled");
    expect(rec).toBeTruthy();
    const decision = rec!.decision as { erased?: unknown };
    const erased = (decision.erased as string[]).join(" ");
    expect(erased).toMatch(/catalog_product/i);
    expect(erased).toMatch(/tombstone|soft-delet/i);
    expect(erased).not.toMatch(/admin.*token/i);
  });

  it("shop/redact (HMAC-covered shop_domain) DOES delete the admin token + hard-retire the catalog", async () => {
    const h = await harness();
    await seedProducts(h.catalogProduct);

    const res = await h.post(WEBHOOK_ROUTES.shopRedact, "shop/redact", shopRedactBody());
    expect(res.statusCode).toBe(200);

    expect(h.adminTokens.deleteCalls).toHaveLength(1);
    expect(h.adminTokens.deleteCalls[0]?.tenantId).toBe(TENANT);
    expect(h.adminTokens.deleteCalls[0]?.opts.actor).toBeTruthy();

    // Hard retire: deleteTenant removes the tenant's rows entirely, including tombstoned ones.
    expect(await h.catalogProduct.listByTenant(TENANT, { includeDeleted: true })).toEqual([]);
  });

  it("shop/redact applied path audits the admin token + catalog_product as hard-deleted", async () => {
    const h = await harness();
    await seedProducts(h.catalogProduct);

    await h.post(WEBHOOK_ROUTES.shopRedact, "shop/redact", shopRedactBody());

    const audit = await h.store.readAudit({ tenantId: TENANT });
    const rec = audit.find((r) => r.action === "shop.redact_applied");
    expect(rec).toBeTruthy();
    const decision = rec!.decision as { erased?: unknown; notErased?: unknown };
    const erased = (decision.erased as string[]).join(" ");
    expect(erased).toMatch(/admin.*token/i);
    expect(erased).toMatch(/catalog_product/i);
    expect((decision.notErased as string[]).join(" ")).not.toMatch(/admin.*token.*no admin-token store/i);
  });

  it("shop/redact: the kill-deferred path does NOT hard-delete the admin token or the catalog", async () => {
    const h = await harness({ killCheck: async () => true });
    await seedProducts(h.catalogProduct);

    const res = await h.post(WEBHOOK_ROUTES.shopRedact, "shop/redact", shopRedactBody());
    expect(res.statusCode).toBe(200);

    const audit = await h.store.readAudit({ tenantId: TENANT });
    expect(audit.find((r) => r.action === "shop.redact_deferred")).toBeTruthy();
    expect(audit.find((r) => r.action === "shop.redact_applied")).toBeFalsy();

    expect(h.adminTokens.deleteCalls).toHaveLength(0);
    // The catalog corpus (vector) is unconditionally erased per S4 §F, but the catalog_product TABLE
    // (Task 9's new hard-retire) must not be touched on the deferred path — the row survives.
    expect(await h.catalogProduct.listByTenant(TENANT, { includeDeleted: true })).toHaveLength(1);
  });

  it("shop/redact: absent adminTokens/catalogProduct deps is a safe no-op (inert-by-absence), not a crash", async () => {
    const h = await harness({ withAdminTokens: false, withCatalogProduct: false });

    const res = await h.post(WEBHOOK_ROUTES.shopRedact, "shop/redact", shopRedactBody());
    expect(res.statusCode).toBe(200);

    const audit = await h.store.readAudit({ tenantId: TENANT });
    const rec = audit.find((r) => r.action === "shop.redact_applied");
    const decision = rec!.decision as { notErased?: unknown };
    expect((decision.notErased as string[]).join(" ")).toMatch(/admin.*token.*no admin-token store/i);
    expect((decision.notErased as string[]).join(" ")).toMatch(/catalog_product.*no catalog-product store/i);
  });

  it("app/uninstalled: absent catalogProduct dep is a safe no-op", async () => {
    const h = await harness({ withCatalogProduct: false });
    const res = await h.post(WEBHOOK_ROUTES.appUninstalled, "app/uninstalled", appUninstalledBody());
    expect(res.statusCode).toBe(200);
  });

  it("REVIEW FIX: adminTokens.delete throwing on shop/redact's applied path is caught, still 200, and writes a failure audit entry (never a silent false claim)", async () => {
    const h = await harness({ adminTokensThrowOnDelete: true });
    await seedProducts(h.catalogProduct);

    const res = await h.post(WEBHOOK_ROUTES.shopRedact, "shop/redact", shopRedactBody());
    expect(res.statusCode).toBe(200); // never a 500 — Shopify's retries must not be burned over this

    // The upfront audit-first record still exists (audit-first-then-act), but the trail must NOT be left
    // silently asserting an erasure that did not occur — a corrective failure audit is required.
    const audit = await h.store.readAudit({ tenantId: TENANT });
    expect(audit.find((r) => r.action === "shop.redact_applied")).toBeTruthy();
    const failRec = audit.find((r) => r.action === "admin_token.delete_failed");
    expect(failRec, "a caught adminTokens.delete failure must be audited, not just console.error'd").toBeTruthy();
    const decision = failRec!.decision as { complete?: unknown; notErased?: unknown };
    expect(decision.complete).toBe(false);
    expect((decision.notErased as string[]).join(" ")).toMatch(/admin.*token/i);

    // The independent catalog_product hard-retire must still have run (each call is caught separately).
    expect(await h.catalogProduct.listByTenant(TENANT, { includeDeleted: true })).toEqual([]);
  });

  it("REVIEW FIX: catalogProduct.deleteTenant throwing on shop/redact's applied path is caught, still 200, and writes a failure audit entry", async () => {
    const h = await harness({ catalogProductThrowOnDeleteTenant: true });
    await seedProducts(h.catalogProduct);

    const res = await h.post(WEBHOOK_ROUTES.shopRedact, "shop/redact", shopRedactBody());
    expect(res.statusCode).toBe(200);

    expect(h.adminTokens.deleteCalls).toHaveLength(1); // the independent admin-token delete still ran

    const audit = await h.store.readAudit({ tenantId: TENANT });
    const failRec = audit.find((r) => r.action === "catalog_product.delete_tenant_failed");
    expect(failRec, "a caught catalogProduct.deleteTenant failure must be audited, not just console.error'd").toBeTruthy();
    const decision = failRec!.decision as { complete?: unknown; notErased?: unknown };
    expect(decision.complete).toBe(false);
    expect((decision.notErased as string[]).join(" ")).toMatch(/catalog_product/i);

    // The row survived the (simulated) failed hard-retire — it's on the REAL underlying store, untouched
    // by the throwing wrapper.
    expect(await h.catalogProduct.listByTenant(TENANT, { includeDeleted: true })).toHaveLength(1);
  });

  it("HMAC verify still precedes the teardown: a bad HMAC on shop/redact is refused and deletes nothing", async () => {
    const h = await harness();
    await seedProducts(h.catalogProduct);

    const res = await h.post(WEBHOOK_ROUTES.shopRedact, "shop/redact", shopRedactBody(), { hmac: "not-a-valid-signature" });
    expect(res.statusCode).toBe(401);

    expect(h.adminTokens.deleteCalls).toHaveLength(0);
    expect(await h.catalogProduct.listByTenant(TENANT, { includeDeleted: true })).toHaveLength(1);
  });
});
