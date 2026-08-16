import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import Fastify from "fastify";
import {
  InMemoryRuntimeStore,
  createInMemoryMerchantRegistry,
  createInMemoryVectorStore,
  requireEmbedInputs,
} from "@palup/platform-ports";
import type {
  EmbedRequest,
  EmbedResponse,
  GroundingContext,
  MerchantRegistryPort,
  ModelPort,
  Product,
  RuntimeStatePort,
  VectorPort,
} from "@palup/platform-ports";
import { registerShopifyWebhookRoutes, WEBHOOK_ROUTES } from "../src/routes/shopify-webhooks.js";
import { runCatalogIndex, catalogNamespace, MANIFEST_COLLECTION, type CatalogSource } from "../src/jobs/catalog-index.js";
import { listLedgerChunkKeys } from "../src/jobs/catalog-ledger.js";

// S4 §F — the wiring that closes the SHOP_REDACT_RESIDUAL / app-uninstalled-non-destructive gap: both
// `shop/redact` and `app/uninstalled` now call `runCatalogClear` (pgvector-safe, S4 Task 6) so a shop's
// catalog corpus namespace + its corpus-state ledger are ACTUALLY erased, not merely disclosed as
// un-erased residuals. Both calls are UNCONDITIONAL — never gated on `killCheck` — per the controller
// ruling: NN#4's Kill Switch halts AGENT AUTONOMY, not a merchant's/law's own erasure request.

const SHOP = "acme-store.myshopify.com";
const TENANT = "acme-store";
const APP_SECRET = "app-client-secret-never-logged";
const EMBED_KEY = "pk_acme_embed_key";
const DIMENSION = 8;

function fakeModel(): ModelPort {
  return {
    async complete() {
      return { text: "ok", model: "fe" };
    },
    async embed(req: EmbedRequest): Promise<EmbedResponse> {
      requireEmbedInputs(req);
      return {
        vectors: req.texts.map((t) => {
          const v = new Array(DIMENSION).fill(0);
          for (let i = 0; i < t.length; i++) v[i % DIMENSION] += 1;
          return v;
        }),
        model: "fe",
        dimension: DIMENSION,
        purpose: req.purpose,
      };
    },
  };
}

function catalog(): CatalogSource {
  return async (t): Promise<GroundingContext> => ({
    tenantId: t,
    brandName: "B",
    products: [{ id: "gid://shopify/Product/1", title: "t", description: "d", price: "$1", tags: ["x"], availableForSale: true }] as Product[],
    policy: { returns: "", shipping: "" },
  });
}

function signBody(raw: string, secret = APP_SECRET): string {
  return createHmac("sha256", secret).update(raw, "utf8").digest("base64");
}

let webhookSeq = 0;
function nextWebhookId(): string {
  webhookSeq += 1;
  return `wh-catalog-erasure-${webhookSeq}`;
}

interface Harness {
  post: (path: string, topic: string, raw: string, opts?: { webhookId?: string; hmac?: string | null }) => Promise<{ statusCode: number; body: string }>;
  store: RuntimeStatePort;
  registry: MerchantRegistryPort;
  vector: VectorPort;
}

async function harness(opts: { killCheck?: (tenantId: string) => Promise<boolean>; vector?: VectorPort } = {}): Promise<Harness> {
  const app = Fastify();
  const store = new InMemoryRuntimeStore();
  const registry = createInMemoryMerchantRegistry();
  const vector: VectorPort = opts.vector ?? createInMemoryVectorStore();
  await registry.create({ tenantId: TENANT, shopDomain: SHOP, embedKey: EMBED_KEY, region: "us" });

  registerShopifyWebhookRoutes(app, {
    store,
    registry,
    vector,
    clientSecret: async () => APP_SECRET,
    killCheck: opts.killCheck ?? (async () => false),
    now: () => Date.now(),
  });
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

  return { post, store, registry, vector };
}

const shopRedactBody = (): string => JSON.stringify({ shop_id: 954889, shop_domain: SHOP });
const appUninstalledBody = (): string => JSON.stringify({ id: 548380009, name: "Acme", domain: null, myshopify_domain: null, plan_name: "enterprise" });

/** Corrupts the tenant's ledger by writing a chunk that holds a non-`product:` id — `readCorpusLedger`'s
 *  intrinsic foreign-guard throws `CatalogRefusal` on this, which is what `runCatalogClear` surfaces. */
async function corruptLedger(store: RuntimeStatePort, tenantId: string): Promise<void> {
  await store.put({ tenantId }, MANIFEST_COLLECTION, "ledger:0000", {
    version: 1,
    at: new Date().toISOString(),
    entries: { "not-a-product-id": "deadbeef" },
  });
}

describe("S4 §F — shop/redact + app/uninstalled erase the catalog corpus + ledger", () => {
  it("shop/redact (not halted) runs runCatalogClear — ledger chunks + vector namespace gone", async () => {
    const h = await harness();
    await runCatalogIndex({ store: h.store, vector: h.vector, model: fakeModel(), catalog: catalog() }, [TENANT], {});
    expect((await listLedgerChunkKeys(h.store, TENANT)).length).toBeGreaterThan(0);
    expect(await h.vector.query(catalogNamespace(TENANT), { text: "", k: 10 })).not.toHaveLength(0);

    const res = await h.post(WEBHOOK_ROUTES.shopRedact, "shop/redact", shopRedactBody());
    expect(res.statusCode).toBe(200);

    expect(await listLedgerChunkKeys(h.store, TENANT)).toEqual([]);
    expect(await h.vector.query(catalogNamespace(TENANT), { text: "", k: 10 })).toHaveLength(0);
  });

  it("app/uninstalled (not halted) runs runCatalogClear — ledger chunks + vector namespace gone", async () => {
    const h = await harness();
    await runCatalogIndex({ store: h.store, vector: h.vector, model: fakeModel(), catalog: catalog() }, [TENANT], {});
    expect((await listLedgerChunkKeys(h.store, TENANT)).length).toBeGreaterThan(0);

    const res = await h.post(WEBHOOK_ROUTES.appUninstalled, "app/uninstalled", appUninstalledBody());
    expect(res.statusCode).toBe(200);

    expect(await listLedgerChunkKeys(h.store, TENANT)).toEqual([]);
    expect(await h.vector.query(catalogNamespace(TENANT), { text: "", k: 10 })).toHaveLength(0);
  });

  it("shop/redact: a runCatalogClear throw (corrupt ledger ⇒ CatalogRefusal) is CAUGHT — 200, not 500, and audited", async () => {
    const h = await harness();
    await runCatalogIndex({ store: h.store, vector: h.vector, model: fakeModel(), catalog: catalog() }, [TENANT], {});
    await corruptLedger(h.store, TENANT);

    const res = await h.post(WEBHOOK_ROUTES.shopRedact, "shop/redact", shopRedactBody());
    expect(res.statusCode).toBe(200);

    const audit = await h.store.readAudit({ tenantId: TENANT });
    const failRec = audit.find((r) => r.action === "catalog.clear_failed");
    expect(failRec, "a caught runCatalogClear failure must be audited, not swallowed silently").toBeTruthy();
    const decision = failRec!.decision as { complete?: unknown; notErased?: unknown };
    expect(decision.complete).toBe(false);
    expect(Array.isArray(decision.notErased)).toBe(true);
    expect((decision.notErased as string[]).join(" ")).toMatch(/catalog corpus|corpus-state ledger/i);
  });

  it("app/uninstalled: a runCatalogClear throw is CAUGHT — still 200, still makes the merchant inert, and is audited", async () => {
    const h = await harness();
    await runCatalogIndex({ store: h.store, vector: h.vector, model: fakeModel(), catalog: catalog() }, [TENANT], {});
    await corruptLedger(h.store, TENANT);

    const res = await h.post(WEBHOOK_ROUTES.appUninstalled, "app/uninstalled", appUninstalledBody());
    expect(res.statusCode).toBe(200);
    expect(await h.registry.lookupByTenantId(TENANT)).toBeNull();

    const audit = await h.store.readAudit({ tenantId: TENANT });
    expect(audit.find((r) => r.action === "catalog.clear_failed")).toBeTruthy();
  });

  it("shop/redact: erasure of the catalog corpus runs even while a kill is ARMED (unconditional, not gated)", async () => {
    const h = await harness({ killCheck: async () => true });
    await runCatalogIndex({ store: h.store, vector: h.vector, model: fakeModel(), catalog: catalog() }, [TENANT], {});

    const res = await h.post(WEBHOOK_ROUTES.shopRedact, "shop/redact", shopRedactBody());
    expect(res.statusCode).toBe(200);
    // The halted branch fires (memory/traffic erasure deferred)...
    const audit = await h.store.readAudit({ tenantId: TENANT });
    expect(audit.find((r) => r.action === "shop.redact_deferred")).toBeTruthy();
    // ...but the catalog corpus is erased regardless of the halt.
    expect(await listLedgerChunkKeys(h.store, TENANT)).toEqual([]);
    expect(await h.vector.query(catalogNamespace(TENANT), { text: "", k: 10 })).toHaveLength(0);
  });

  it("app/uninstalled: erasure of the catalog corpus runs even while a kill is ARMED (unconditional, not gated)", async () => {
    const h = await harness({ killCheck: async () => true });
    await runCatalogIndex({ store: h.store, vector: h.vector, model: fakeModel(), catalog: catalog() }, [TENANT], {});

    const res = await h.post(WEBHOOK_ROUTES.appUninstalled, "app/uninstalled", appUninstalledBody());
    expect(res.statusCode).toBe(200);
    expect(await listLedgerChunkKeys(h.store, TENANT)).toEqual([]);
  });

  it("SHOP_REDACT_RESIDUAL no longer discloses the catalog corpus/ledger as un-erased on the success path", async () => {
    const h = await harness();
    await runCatalogIndex({ store: h.store, vector: h.vector, model: fakeModel(), catalog: catalog() }, [TENANT], {});

    await h.post(WEBHOOK_ROUTES.shopRedact, "shop/redact", shopRedactBody());
    const audit = await h.store.readAudit({ tenantId: TENANT });
    const rec = audit.find((r) => r.action === "shop.redact_applied");
    expect(rec).toBeTruthy();
    const decision = rec!.decision as { erased?: unknown; notErased?: unknown };
    // It IS now claimed erased...
    expect((decision.erased as string[]).join(" ")).toMatch(/catalog corpus/i);
    // ...and no longer listed as a residual gap.
    const notErased = (decision.notErased as string[]).join(" ");
    expect(notErased).not.toMatch(/catalog corpus/i);
    expect(notErased).not.toMatch(/corpus-state ledger/i);
  });

  it("HMAC verify still precedes erasure: a bad HMAC on shop/redact is refused (401) and erases nothing", async () => {
    const h = await harness();
    await runCatalogIndex({ store: h.store, vector: h.vector, model: fakeModel(), catalog: catalog() }, [TENANT], {});
    const before = (await listLedgerChunkKeys(h.store, TENANT)).length;
    expect(before).toBeGreaterThan(0);

    const res = await h.post(WEBHOOK_ROUTES.shopRedact, "shop/redact", shopRedactBody(), { hmac: "not-a-valid-signature" });
    expect(res.statusCode).toBe(401);
    expect(await listLedgerChunkKeys(h.store, TENANT)).toHaveLength(before);
  });

  it("HMAC verify still precedes erasure: a bad HMAC on app/uninstalled is refused (401) and erases nothing", async () => {
    const h = await harness();
    await runCatalogIndex({ store: h.store, vector: h.vector, model: fakeModel(), catalog: catalog() }, [TENANT], {});
    const before = (await listLedgerChunkKeys(h.store, TENANT)).length;
    expect(before).toBeGreaterThan(0);

    const res = await h.post(WEBHOOK_ROUTES.appUninstalled, "app/uninstalled", appUninstalledBody(), { hmac: "not-a-valid-signature" });
    expect(res.statusCode).toBe(401);
    expect(await listLedgerChunkKeys(h.store, TENANT)).toHaveLength(before);
    expect(await h.registry.lookupByTenantId(TENANT)).not.toBeNull();
  });
});
