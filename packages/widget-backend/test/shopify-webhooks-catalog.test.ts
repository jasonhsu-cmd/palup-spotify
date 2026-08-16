import { describe, it, expect, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import Fastify from "fastify";
import { InMemoryRuntimeStore, createInMemoryMerchantRegistry, createInMemoryVectorStore } from "@palup/platform-ports";
import type { MerchantRegistryPort, QueueMessage, QueuePort, RuntimeStatePort, VectorPort } from "@palup/platform-ports";
import { registerShopifyWebhookRoutes, WEBHOOK_ROUTES } from "../src/routes/shopify-webhooks.js";

// S3 §C — the webhook route wires `productIdOf` into `handleCatalogChange` so a products/* delivery
// carries the changed product's Storefront GID (reason:"product"), an inventory tick carries neither id
// nor crawl trigger (reason:"inventory" — the Storefront delegate token cannot resolve an
// inventory_item_id to a product), and anything unparseable falls back to reason:"full" (the safe
// whole-catalog backstop). This exercises the ROUTE (registerShopifyWebhookRoutes directly, with an
// injected queue) rather than the full server, since `buildServer` builds its own queue internally when
// CATALOG_WEBHOOKS is on and has no seam to intercept `publish`.

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
  return `wh-catalog-${webhookSeq}`;
}

let published: QueueMessage[] = [];

/** A minimal QueuePort whose `publish` just records the message — this file tests the ENQUEUE shape, not
 *  delivery/dedup (that is `catalog-webhook-queue.test.ts`'s job). */
function recordingQueue(): QueuePort {
  return {
    async publish(_topic, msg) {
      published.push(msg);
    },
    subscribe() {
      return { unsubscribe() {} };
    },
    deadLettered() {
      return [];
    },
  };
}

interface Harness {
  post: (path: string, topic: string, raw: string, opts?: { webhookId?: string; hmac?: string }) => Promise<{ statusCode: number; body: string }>;
  store: RuntimeStatePort;
  registry: MerchantRegistryPort;
}

async function harness(): Promise<Harness> {
  const app = Fastify();
  const store = new InMemoryRuntimeStore();
  const registry = createInMemoryMerchantRegistry();
  const vector: VectorPort = createInMemoryVectorStore();
  await registry.create({ tenantId: TENANT, shopDomain: SHOP, embedKey: EMBED_KEY, region: "us" });

  registerShopifyWebhookRoutes(app, {
    store,
    registry,
    vector,
    clientSecret: async () => APP_SECRET,
    killCheck: async () => false,
    now: () => Date.now(),
    queue: recordingQueue(),
  });
  await app.ready();

  const post = async (path: string, topic: string, raw: string, opts: { webhookId?: string; hmac?: string } = {}) => {
    const res = await app.inject({
      method: "POST",
      url: path,
      headers: {
        "content-type": "application/json",
        "x-shopify-topic": topic,
        "x-shopify-api-version": "2026-07",
        "x-shopify-webhook-id": opts.webhookId ?? nextWebhookId(),
        "x-shopify-shop-domain": SHOP,
        "x-shopify-hmac-sha256": opts.hmac ?? signBody(raw),
      },
      payload: raw,
    });
    return { statusCode: res.statusCode, body: res.body };
  };

  return { post, store, registry };
}

afterEach(() => {
  published = [];
});

describe("S3 §C — handleCatalogChange enqueues productIds + reason", () => {
  it("products/update enqueues a targeted reconcile with the GID and reason:product", async () => {
    const h = await harness();
    const res = await h.post(WEBHOOK_ROUTES.productsUpdate, "products/update", JSON.stringify({ id: 7 }));
    expect(res.statusCode).toBe(200);
    expect(published).toHaveLength(1);
    expect(published[0]!.payload).toMatchObject({
      reason: "product",
      productIds: ["gid://shopify/Product/7"],
    });
  });

  it("products/create enqueues reason:product with the GID", async () => {
    const h = await harness();
    await h.post(WEBHOOK_ROUTES.productsCreate, "products/create", JSON.stringify({ id: 42 }));
    expect(published[0]!.payload).toMatchObject({ reason: "product", productIds: ["gid://shopify/Product/42"] });
  });

  it("products/delete enqueues reason:product with the GID (the worker deletes without a fetch)", async () => {
    const h = await harness();
    await h.post(WEBHOOK_ROUTES.productsDelete, "products/delete", JSON.stringify({ id: 9 }));
    expect(published[0]!.payload).toMatchObject({ reason: "product", productIds: ["gid://shopify/Product/9"] });
  });

  it("inventory_levels/update enqueues reason:inventory with NO productIds (no per-event crawl)", async () => {
    const h = await harness();
    await h.post(WEBHOOK_ROUTES.inventoryLevelsUpdate, "inventory_levels/update", JSON.stringify({ inventory_item_id: 3 }));
    expect(published[0]!.payload).toMatchObject({ reason: "inventory" });
    expect((published[0]!.payload as { productIds?: unknown }).productIds).toBeUndefined();
  });

  it("an unparseable/refused product id falls back to reason:full with no productIds (safe backstop)", async () => {
    const h = await harness();
    // A GID string (not a bare numeric id) — matchesPayloadShape still accepts it (only requires `id`
    // present), but productIdOf refuses to coerce it, so the reconcile falls back to a full crawl.
    await h.post(WEBHOOK_ROUTES.productsUpdate, "products/update", JSON.stringify({ id: "gid://shopify/Product/7" }));
    expect(published[0]!.payload).toMatchObject({ reason: "full" });
    expect((published[0]!.payload as { productIds?: unknown }).productIds).toBeUndefined();
  });

  it("no product data crosses the port for a targeted reconcile beyond the GID", async () => {
    const h = await harness();
    await h.post(WEBHOOK_ROUTES.productsUpdate, "products/update", JSON.stringify({ id: 7 }));
    expect(JSON.stringify(published[0])).not.toMatch(/price|title|variant|inventory_item/i);
  });
});
