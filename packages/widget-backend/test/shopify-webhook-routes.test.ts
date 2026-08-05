import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { InMemoryRuntimeStore, createInMemoryMerchantRegistry, createInMemoryVectorStore } from "@palup/platform-ports";
import type { AuditRecord, MerchantRegistryPort, RuntimeStatePort, VectorPort } from "@palup/platform-ports";
import { armKill, disarmKill } from "@palup/state-postgres";
import { subjectNamespace, accountSubjectId, recordSubject, listSubjects } from "@palup/widget-memory";
import { buildServer } from "../src/server.js";
import { SHOPIFY_APP_CLIENT_SECRET_NAME, SHOPIFY_APP_SECRET_SCOPE } from "../src/shopify-install-identity.js";
import {
  WEBHOOK_SEEN_COLLECTION,
  DATA_REQUEST_COLLECTION,
  WEBHOOK_ROUTES,
} from "../src/routes/shopify-webhooks.js";

// C2 — the three MANDATORY Shopify compliance webhooks plus `app/uninstalled`, exercised END TO END
// through the real Fastify app. Driving it through `app.inject` is the whole point: the property under
// test is that an UNAUTHENTICATED, INTERNET-REACHABLE POST cannot change merchant state or delete data
// unless its HMAC over the EXACT RAW BYTES verifies against the app client secret. A unit test on the
// handler function could not prove that the ROUTE captured the raw body before Fastify parsed it.
//
// The properties this file exists to hold, in priority order:
//   1. RAW-BODY HMAC OR NOTHING. A body whose HMAC was computed over a re-serialized (byte-different but
//      JSON-equal) form is REFUSED — the positive/negative pair at "the raw body, not the parsed body"
//      is the only test that can distinguish a correct implementation from one that HMACs
//      `JSON.stringify(req.body)` and happens to pass on tidy input.
//   2. 401 ON A BAD HMAC. Shopify's App Review requirement, verbatim: "If a mandatory compliance webhook
//      sends a request with an invalid Shopify HMAC header, then the app must return a 401 Unauthorized
//      HTTP status."
//   3. NO CROSS-TOPIC ESCALATION. Both the URL and the `X-Shopify-Topic` header are attacker-choosable;
//      only the BODY is HMAC-covered. So a validly-signed `customers/redact` body replayed at the
//      `shop/redact` path must not revoke a whole merchant.
//   4. `app/uninstalled` MAKES THE MERCHANT INERT, verified through the registry's own default-inert
//      lookups rather than by reading the status field back.
//   5. IDEMPOTENCY AND REPLAY. A redelivery must not double-act; a replayed old delivery must never
//      resurrect a revoked merchant.
//   6. NOTHING LEAKS. Asserted against the FULL JSON of every audit record, every response body and
//      every console line — the style C1 (#189) and B2 (#186) use.
//   7. THE HANDLERS DO NOT OVERCLAIM. `customers/data_request` must erase NOTHING, and every audit
//      record must name what was NOT erased.

const SHOP = "acme-store.myshopify.com";
const TENANT = "acme-store";
const OTHER_SHOP = "beta-store.myshopify.com";
const OTHER_TENANT = "beta-store";
const APP_SECRET = "app-client-secret-never-logged";
const EMBED_KEY = "pk_acme_embed_key";
const CUSTOMER_ID = "191167";
const OTHER_CUSTOMER_ID = "770042";
const CUSTOMER_EMAIL = "john@example.com";
const CUSTOMER_PHONE = "555-625-1199";
const GUEST_ANON = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** `acct:shopify:<tenant>:<numeric customer id>` — the memory subject a SIGNED-IN Shopify shopper gets
 *  (`buildShopifyShopperId` + `accountSubjectId`). This is the one link from a Shopify customer id to
 *  anything this system stores, and it is what makes `customers/redact` partially real. */
const ACCOUNT_SUBJECT = accountSubjectId(`shopify:${TENANT}:${CUSTOMER_ID}`);
const OTHER_ACCOUNT_SUBJECT = accountSubjectId(`shopify:${TENANT}:${OTHER_CUSTOMER_ID}`);

const ENV_KEYS = ["PALUP_SECRETS", "WIDGET_EMBED_KEYS", "SHOPIFY_STORES", "SHOPIFY_APP_CLIENT_ID"];
afterEach(() => ENV_KEYS.forEach((k) => delete process.env[k]));

// ── Signing, exactly as Shopify documents it for WEBHOOKS (a different scheme from the OAuth query
// signer C1 uses): base64 HMAC-SHA256 of the app client secret over the RAW, UNPARSED request body.
function signBody(raw: string, secret = APP_SECRET): string {
  return createHmac("sha256", secret).update(raw, "utf8").digest("base64");
}

let webhookSeq = 0;
function nextWebhookId(): string {
  webhookSeq += 1;
  return `b54557e4-webhook-${webhookSeq}`;
}

interface PostOpts {
  raw: string;
  topic: string;
  hmac?: string | null;
  /** An array-valued header, i.e. the header arrived twice. */
  hmacArray?: string[];
  webhookId?: string;
  shopHeader?: string | null;
  contentType?: string;
}

interface Harness {
  app: Awaited<ReturnType<typeof buildServer>>;
  store: RuntimeStatePort;
  registry: MerchantRegistryPort;
  vector: VectorPort;
  post: (path: string, opts: PostOpts) => Promise<{ statusCode: number; body: string }>;
}

/** The fully-configured, ENABLED webhook feature. `over` removes/overrides env so the gating tests can
 *  prove each precondition is individually load-bearing. */
async function harness(
  over: Record<string, string | undefined> = {},
  seams: { registry?: MerchantRegistryPort | null; store?: RuntimeStatePort; vector?: VectorPort } = {},
): Promise<Harness> {
  process.env.PALUP_SECRETS = JSON.stringify({
    [SHOPIFY_APP_SECRET_SCOPE]: { [SHOPIFY_APP_CLIENT_SECRET_NAME]: APP_SECRET },
  });
  for (const [k, v] of Object.entries(over)) v === undefined ? delete process.env[k] : (process.env[k] = v);

  const store = seams.store ?? new InMemoryRuntimeStore();
  const registry = seams.registry === null ? undefined : (seams.registry ?? createInMemoryMerchantRegistry());
  const vector = seams.vector ?? createInMemoryVectorStore();
  const app = await buildServer({ store, merchantRegistry: registry, vectorPort: vector });

  const post = async (path: string, o: PostOpts): Promise<{ statusCode: number; body: string }> => {
    const headers: Record<string, string | string[]> = {
      "content-type": o.contentType ?? "application/json",
      "x-shopify-topic": o.topic,
      "x-shopify-api-version": "2026-07",
      "x-shopify-webhook-id": o.webhookId ?? nextWebhookId(),
    };
    if (o.shopHeader !== null) headers["x-shopify-shop-domain"] = o.shopHeader ?? SHOP;
    if (o.hmacArray) headers["x-shopify-hmac-sha256"] = o.hmacArray;
    else if (o.hmac !== null) headers["x-shopify-hmac-sha256"] = o.hmac ?? signBody(o.raw);
    const res = await app.inject({ method: "POST", url: path, headers, payload: o.raw });
    return { statusCode: res.statusCode, body: res.body };
  };

  return { app, store, registry: registry as MerchantRegistryPort, vector, post };
}

/** Register a merchant the way C1's callback would, so the webhooks have something to act on. */
async function seedMerchant(registry: MerchantRegistryPort, shop = SHOP, tenant = TENANT, embedKey = EMBED_KEY) {
  return registry.create({ tenantId: tenant, shopDomain: shop, embedKey, region: "us" });
}

async function auditFor(store: RuntimeStatePort, tenantId: string): Promise<AuditRecord[]> {
  return store.readAudit({ tenantId });
}

/** Every secret-ish / personal string this test knows about. None may appear anywhere observable. */
const NEVER_OBSERVABLE = [APP_SECRET, CUSTOMER_EMAIL, CUSTOMER_PHONE, CUSTOMER_ID];

function expectNothingLeaked(haystack: string, what: string): void {
  for (const s of NEVER_OBSERVABLE) {
    expect(haystack, `${what} must not contain ${JSON.stringify(s.slice(0, 14))}…`).not.toContain(s);
  }
}

// ── The documented payloads, verbatim shapes from shopify.dev's own samples ────────────────────────
const dataRequestBody = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    shop_id: 954889,
    shop_domain: SHOP,
    orders_requested: [299938, 280263, 220458],
    customer: { id: Number(CUSTOMER_ID), email: CUSTOMER_EMAIL, phone: CUSTOMER_PHONE },
    data_request: { id: 9999 },
    ...over,
  });

const customerRedactBody = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    shop_id: 954889,
    shop_domain: SHOP,
    customer: { id: Number(CUSTOMER_ID), email: CUSTOMER_EMAIL, phone: CUSTOMER_PHONE },
    orders_to_redact: [299938, 280263, 220458],
    ...over,
  });

const shopRedactBody = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ shop_id: 954889, shop_domain: SHOP, ...over });

/** `app/uninstalled` carries a SHOP object, and shopify.dev's own sample has `myshopify_domain: null`
 *  and `domain: null` — so the authoritative shop for this topic is the (UNSIGNED) header. */
const appUninstalledBody = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ id: 548380009, name: "Super Toys", domain: null, myshopify_domain: null, plan_name: "enterprise", ...over });

// ---------------------------------------------------------------------------------------------------
describe("C2 gating — the webhook routes are inert unless the app secret AND a durable registry exist", () => {
  it("all four routes 404 when the app client secret is not provisioned in the SecretsPort", async () => {
    const h = await harness({ PALUP_SECRETS: JSON.stringify({ other: { x: "y" } }) });
    for (const path of Object.values(WEBHOOK_ROUTES)) {
      const res = await h.post(path, { raw: shopRedactBody(), topic: "shop/redact" });
      expect(res.statusCode, `${path} must be absent, not half-working`).toBe(404);
    }
  });

  it("all four routes 404 without a merchant registry — there is no tenant to resolve or revoke", async () => {
    const h = await harness({}, { registry: null });
    for (const path of Object.values(WEBHOOK_ROUTES)) {
      const res = await h.post(path, { raw: shopRedactBody(), topic: "shop/redact" });
      expect(res.statusCode).toBe(404);
    }
  });

  it("all four routes exist when fully configured", async () => {
    const h = await harness();
    await seedMerchant(h.registry);
    for (const path of Object.values(WEBHOOK_ROUTES)) {
      const res = await h.post(path, { raw: shopRedactBody(), topic: "shop/redact" });
      expect(res.statusCode, `${path} must not 404 when configured`).not.toBe(404);
    }
  });
});

// ---------------------------------------------------------------------------------------------------
describe("C2 — HMAC over the RAW body, or nothing happens", () => {
  it("a valid HMAC over the exact raw bytes is accepted (200)", async () => {
    const h = await harness();
    await seedMerchant(h.registry);
    const raw = shopRedactBody();
    const res = await h.post(WEBHOOK_ROUTES.shopRedact, { raw, topic: "shop/redact" });
    expect(res.statusCode).toBe(200);
  });

  it("THE RAW BODY, NOT THE PARSED BODY: a byte-different but JSON-EQUAL body is refused", async () => {
    const h = await harness();
    await seedMerchant(h.registry);
    // Same JSON value, different bytes: whitespace + key order. An implementation that HMACs
    // `JSON.stringify(req.body)` would accept this; one that HMACs the raw bytes cannot.
    const signed = shopRedactBody();
    const reserialized = JSON.stringify(JSON.parse(signed), null, 2);
    expect(reserialized).not.toBe(signed);
    const res = await h.post(WEBHOOK_ROUTES.shopRedact, {
      raw: reserialized,
      topic: "shop/redact",
      hmac: signBody(signed),
    });
    expect(res.statusCode).toBe(401);
    expect((await h.registry.lookupByTenantId(TENANT, { includeInactive: true }))!.status).toBe("active");
  });

  it("...and the same odd-byte body IS accepted when the HMAC covers its actual bytes", async () => {
    const h = await harness();
    await seedMerchant(h.registry);
    const raw = JSON.stringify(JSON.parse(shopRedactBody()), null, 2);
    const res = await h.post(WEBHOOK_ROUTES.shopRedact, { raw, topic: "shop/redact", hmac: signBody(raw) });
    expect(res.statusCode).toBe(200);
  });

  it("an invalid HMAC returns 401 — Shopify's App Review requirement, not our choice", async () => {
    const h = await harness();
    await seedMerchant(h.registry);
    for (const bad of ["", "not-base64!!", "AAAA", signBody(shopRedactBody(), "wrong-secret")]) {
      const res = await h.post(WEBHOOK_ROUTES.shopRedact, { raw: shopRedactBody(), topic: "shop/redact", hmac: bad });
      expect(res.statusCode, `hmac=${JSON.stringify(bad)} must be 401`).toBe(401);
    }
  });

  it("an ABSENT HMAC header returns 401", async () => {
    const h = await harness();
    await seedMerchant(h.registry);
    const res = await h.post(WEBHOOK_ROUTES.shopRedact, { raw: shopRedactBody(), topic: "shop/redact", hmac: null });
    expect(res.statusCode).toBe(401);
  });

  it("a DUPLICATED (array) HMAC header returns 401 — neither value is trustworthy", async () => {
    const h = await harness();
    await seedMerchant(h.registry);
    const good = signBody(shopRedactBody());
    const res = await h.post(WEBHOOK_ROUTES.shopRedact, {
      raw: shopRedactBody(),
      topic: "shop/redact",
      hmacArray: [good, good],
    });
    expect(res.statusCode).toBe(401);
  });

  it("an EMPTY body returns 401 — an empty string HMACs to a fixed value, so it must never verify", async () => {
    const h = await harness();
    await seedMerchant(h.registry);
    const res = await h.post(WEBHOOK_ROUTES.shopRedact, { raw: "", topic: "shop/redact", hmac: signBody("") });
    expect(res.statusCode).toBe(401);
  });

  it("a bad HMAC changes NOTHING: no audit row, no status change, no vector deletion", async () => {
    const h = await harness();
    await seedMerchant(h.registry);
    await h.vector.upsert(subjectNamespace(TENANT, ACCOUNT_SUBJECT), [{ id: "f1", text: "prefers matte", metadata: { class: "ordinary" } }]);
    const before = (await auditFor(h.store, TENANT)).length;

    for (const path of Object.values(WEBHOOK_ROUTES)) {
      await h.post(path, { raw: customerRedactBody(), topic: "customers/redact", hmac: "AAAA" });
    }

    expect((await auditFor(h.store, TENANT)).length).toBe(before);
    expect((await h.registry.lookupByTenantId(TENANT))!.status).toBe("active");
    expect(await h.vector.query(subjectNamespace(TENANT, ACCOUNT_SUBJECT), { text: "", k: 10 })).toHaveLength(1);
  });

  it("the raw-body parser is ENCAPSULATED: sibling JSON routes still get a PARSED body", async () => {
    // If the webhook plugin's catch-all parser leaked to the root scope, every other route in the
    // server would start receiving a Buffer instead of an object. `/consent` reads `req.body.anonId`.
    const h = await harness();
    await seedMerchant(h.registry);
    const res = await h.app.inject({
      method: "POST",
      url: "/consent",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ anonId: GUEST_ANON, memoryOrdinary: "in", memorySpecial: "out" }),
    });
    expect(res.statusCode, `/consent must still parse JSON; got ${res.body}`).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------------------------------
describe("C2 — no cross-topic escalation (the URL and the topic header are attacker-chosen; the body is not)", () => {
  it("a validly-signed customers/redact body POSTed at shop/redact does NOT revoke the merchant", async () => {
    const h = await harness();
    await seedMerchant(h.registry);
    const raw = customerRedactBody();
    const res = await h.post(WEBHOOK_ROUTES.shopRedact, { raw, topic: "shop/redact" });
    expect(res.statusCode).toBe(400);
    expect((await h.registry.lookupByTenantId(TENANT))!.status).toBe("active");
    expect(await auditFor(h.store, TENANT)).toHaveLength(0);
  });

  it("a validly-signed customers/data_request body POSTed at customers/redact erases nothing", async () => {
    const h = await harness();
    await seedMerchant(h.registry);
    await h.vector.upsert(subjectNamespace(TENANT, ACCOUNT_SUBJECT), [{ id: "f1", text: "prefers matte" }]);
    const res = await h.post(WEBHOOK_ROUTES.customersRedact, { raw: dataRequestBody(), topic: "customers/redact" });
    expect(res.statusCode).toBe(400);
    expect(await h.vector.query(subjectNamespace(TENANT, ACCOUNT_SUBJECT), { text: "", k: 10 })).toHaveLength(1);
  });

  it("a validly-signed shop/redact body POSTed at customers/redact is refused (no customer to redact)", async () => {
    const h = await harness();
    await seedMerchant(h.registry);
    const res = await h.post(WEBHOOK_ROUTES.customersRedact, { raw: shopRedactBody(), topic: "customers/redact" });
    expect(res.statusCode).toBe(400);
  });

  it("a validly-signed GDPR body POSTed at app/uninstalled does NOT revoke the merchant", async () => {
    const h = await harness();
    await seedMerchant(h.registry);
    for (const raw of [shopRedactBody(), customerRedactBody(), dataRequestBody()]) {
      const res = await h.post(WEBHOOK_ROUTES.appUninstalled, { raw, topic: "app/uninstalled" });
      expect(res.statusCode).toBe(400);
    }
    expect((await h.registry.lookupByTenantId(TENANT))!.status).toBe("active");
  });

  it("a validly-signed app/uninstalled body POSTed at shop/redact is refused (no HMAC-covered shop)", async () => {
    const h = await harness();
    await seedMerchant(h.registry);
    const res = await h.post(WEBHOOK_ROUTES.shopRedact, { raw: appUninstalledBody(), topic: "app/uninstalled" });
    expect(res.statusCode).toBe(400);
    expect((await h.registry.lookupByTenantId(TENANT))!.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------------------------------
describe("C2 — app/uninstalled makes the merchant INERT, end to end", () => {
  it("every registry lookup resolves to null afterwards (default-inert), without deleting the row", async () => {
    const h = await harness();
    await seedMerchant(h.registry);
    const res = await h.post(WEBHOOK_ROUTES.appUninstalled, { raw: appUninstalledBody(), topic: "app/uninstalled" });
    expect(res.statusCode).toBe(200);

    // The end-to-end property: a caller that never learned about `status` gets nothing.
    expect(await h.registry.lookupByTenantId(TENANT)).toBeNull();
    expect(await h.registry.lookupByShopDomain(SHOP)).toBeNull();
    expect(await h.registry.lookupByEmbedKey(EMBED_KEY)).toBeNull();
    // ...and the row is STILL THERE, so support / billing / erasure can reach it and one command restores it.
    const row = await h.registry.lookupByTenantId(TENANT, { includeInactive: true });
    expect(row).not.toBeNull();
    expect(row!.status).toBe("uninstalled");
    expect(row!.embedKey).toBe(EMBED_KEY);
  });

  it("audits the revocation with a reversalPath naming a tool that EXISTS and an operator can run", async () => {
    const h = await harness();
    await seedMerchant(h.registry);
    await h.post(WEBHOOK_ROUTES.appUninstalled, { raw: appUninstalledBody(), topic: "app/uninstalled" });
    const rows = await auditFor(h.store, TENANT);
    const rec = rows.find((r) => r.action === "merchant.uninstalled");
    expect(rec, `expected a merchant.uninstalled audit row, saw ${rows.map((r) => r.action).join(",")}`).toBeTruthy();
    expect(rec!.actor).toBe("system:shopify-webhook");
    // #179 — no control-plane route, no console: the CLI is the only thing deployed anywhere.
    expect(rec!.reversalPath).toContain("packages/widget-backend/src/jobs/merchant.ts");
    expect(rec!.reversalPath).toContain("--status active");
  });

  it("is IDEMPOTENT: a redelivery of the SAME webhook id acts once and audits once", async () => {
    const h = await harness();
    await seedMerchant(h.registry);
    const raw = appUninstalledBody();
    const id = nextWebhookId();
    const a = await h.post(WEBHOOK_ROUTES.appUninstalled, { raw, topic: "app/uninstalled", webhookId: id });
    const b = await h.post(WEBHOOK_ROUTES.appUninstalled, { raw, topic: "app/uninstalled", webhookId: id });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect((await auditFor(h.store, TENANT)).filter((r) => r.action === "merchant.uninstalled")).toHaveLength(1);
  });

  it("REPLAY: a replayed old delivery can never RESURRECT a revoked merchant", async () => {
    const h = await harness();
    await seedMerchant(h.registry);
    const raw = appUninstalledBody();
    await h.post(WEBHOOK_ROUTES.appUninstalled, { raw, topic: "app/uninstalled" });
    expect(await h.registry.lookupByTenantId(TENANT)).toBeNull();

    // Replay with a FRESH webhook id, so delivery-dedup cannot be what saves us.
    const res = await h.post(WEBHOOK_ROUTES.appUninstalled, { raw, topic: "app/uninstalled", webhookId: nextWebhookId() });
    expect(res.statusCode).toBe(200);
    expect(await h.registry.lookupByTenantId(TENANT)).toBeNull();
    const statuses = (await auditFor(h.store, TENANT))
      .filter((r) => r.action === "merchant.uninstalled")
      .map((r) => JSON.stringify(r.decision));
    // No audit row may ever claim this webhook restored servability.
    for (const d of statuses) expect(d).not.toContain('"active"');
  });

  it("REPLAY: an old delivery replayed AFTER a legitimate re-install does not re-revoke the merchant", async () => {
    const h = await harness();
    await seedMerchant(h.registry);
    const raw = appUninstalledBody();
    const id = nextWebhookId();
    await h.post(WEBHOOK_ROUTES.appUninstalled, { raw, topic: "app/uninstalled", webhookId: id });
    // C1's callback reactivates on re-install.
    await h.registry.setStatus(TENANT, "active", { reason: "app install (Shopify OAuth callback)" });

    const res = await h.post(WEBHOOK_ROUTES.appUninstalled, { raw, topic: "app/uninstalled", webhookId: id });
    expect(res.statusCode).toBe(200);
    expect(await h.registry.lookupByTenantId(TENANT), "the re-installed merchant must stay servable").not.toBeNull();
  });

  it("the shop comes from the header for THIS topic only, and only a shop with a row is touched", async () => {
    const h = await harness();
    await seedMerchant(h.registry);
    await seedMerchant(h.registry, OTHER_SHOP, OTHER_TENANT, "pk_beta_embed_key");
    await h.post(WEBHOOK_ROUTES.appUninstalled, { raw: appUninstalledBody(), topic: "app/uninstalled", shopHeader: OTHER_SHOP });
    expect(await h.registry.lookupByTenantId(OTHER_TENANT)).toBeNull();
    expect(await h.registry.lookupByTenantId(TENANT), "an unrelated merchant must be untouched").not.toBeNull();
  });

  it("an absent shop header on app/uninstalled is refused, never guessed", async () => {
    const h = await harness();
    await seedMerchant(h.registry);
    const res = await h.post(WEBHOOK_ROUTES.appUninstalled, { raw: appUninstalledBody(), topic: "app/uninstalled", shopHeader: null });
    expect(res.statusCode).toBe(400);
    expect(await h.registry.lookupByTenantId(TENANT)).not.toBeNull();
  });

  it("a kill switch does NOT block making a merchant inert (a halt and revocation point the same way)", async () => {
    const h = await harness();
    await seedMerchant(h.registry);
    const scope = `tenant:${TENANT}`;
    await armKill(h.store, scope, "test");
    try {
      const res = await h.post(WEBHOOK_ROUTES.appUninstalled, { raw: appUninstalledBody(), topic: "app/uninstalled" });
      expect(res.statusCode).toBe(200);
      expect(await h.registry.lookupByTenantId(TENANT)).toBeNull();
    } finally {
      await disarmKill(h.store, scope);
    }
  });
});

// ---------------------------------------------------------------------------------------------------
describe("C2 — shop/redact does what it can and audits what it cannot", () => {
  it("revokes the merchant, erases every INDEXED subject's memory, and empties the traffic log", async () => {
    const h = await harness();
    await seedMerchant(h.registry);
    // Two subjects with facts, both in B4's per-tenant subject index (subject-index.ts).
    for (const s of [ACCOUNT_SUBJECT, GUEST_ANON]) {
      await h.vector.upsert(subjectNamespace(TENANT, s), [{ id: `f-${s}`, text: "a stored fact" }]);
      await recordSubject(h.store, { tenantId: TENANT, subject: s });
    }
    // ...and a per-tenant traffic entry, which retains the (redacted) message + reply text.
    await h.store.append({ tenantId: TENANT }, "traffic", { message: "hi", reply: "hello" });
    // A DIFFERENT tenant's data must survive untouched.
    await seedMerchant(h.registry, OTHER_SHOP, OTHER_TENANT, "pk_beta_embed_key");
    await h.vector.upsert(subjectNamespace(OTHER_TENANT, GUEST_ANON), [{ id: "other", text: "another tenant's fact" }]);
    await h.store.append({ tenantId: OTHER_TENANT }, "traffic", { message: "hi", reply: "hello" });

    const res = await h.post(WEBHOOK_ROUTES.shopRedact, { raw: shopRedactBody(), topic: "shop/redact" });
    expect(res.statusCode).toBe(200);

    expect(await h.registry.lookupByTenantId(TENANT)).toBeNull();
    for (const s of [ACCOUNT_SUBJECT, GUEST_ANON]) {
      expect(await h.vector.query(subjectNamespace(TENANT, s), { text: "", k: 10 }), `${s} must be erased`).toHaveLength(0);
    }
    expect(await listSubjects(h.store, TENANT), "the subject index must not keep pointing at erased subjects").toHaveLength(0);
    expect(await h.store.readStream({ tenantId: TENANT }, "traffic")).toHaveLength(0);

    // Tenant isolation.
    expect(await h.vector.query(subjectNamespace(OTHER_TENANT, GUEST_ANON), { text: "", k: 10 })).toHaveLength(1);
    expect(await h.store.readStream({ tenantId: OTHER_TENANT }, "traffic")).toHaveLength(1);
    expect(await h.registry.lookupByTenantId(OTHER_TENANT)).not.toBeNull();
  });

  it("audits BOTH what it erased AND what it did not — an operator must not read this as complete", async () => {
    const h = await harness();
    await seedMerchant(h.registry);
    await h.post(WEBHOOK_ROUTES.shopRedact, { raw: shopRedactBody(), topic: "shop/redact" });
    const rec = (await auditFor(h.store, TENANT)).find((r) => r.action === "shop.redact_applied");
    expect(rec).toBeTruthy();
    const decision = rec!.decision as { complete?: unknown; erased?: unknown; notErased?: unknown };
    expect(decision.complete, "shop/redact is NOT a complete erasure and must not claim to be").toBe(false);
    expect(Array.isArray(decision.erased)).toBe(true);
    expect(Array.isArray(decision.notErased)).toBe(true);
    const notErased = (decision.notErased as string[]).join(" ");
    // The immutable audit chain is deliberately retained (NN#5); it holds hashed refs, never raw ids.
    expect(notErased).toMatch(/audit/i);
  });

  it("is IDEMPOTENT: a redelivery acts once and audits once", async () => {
    const h = await harness();
    await seedMerchant(h.registry);
    const raw = shopRedactBody();
    const id = nextWebhookId();
    expect((await h.post(WEBHOOK_ROUTES.shopRedact, { raw, topic: "shop/redact", webhookId: id })).statusCode).toBe(200);
    expect((await h.post(WEBHOOK_ROUTES.shopRedact, { raw, topic: "shop/redact", webhookId: id })).statusCode).toBe(200);
    expect((await auditFor(h.store, TENANT)).filter((r) => r.action === "shop.redact_applied")).toHaveLength(1);
  });

  it("a shop with NO registry row is acknowledged (200) and nothing is erased anywhere", async () => {
    const h = await harness();
    await seedMerchant(h.registry, OTHER_SHOP, OTHER_TENANT, "pk_beta_embed_key");
    await h.vector.upsert(subjectNamespace(OTHER_TENANT, GUEST_ANON), [{ id: "x", text: "fact" }]);
    const res = await h.post(WEBHOOK_ROUTES.shopRedact, { raw: shopRedactBody(), topic: "shop/redact" });
    expect(res.statusCode).toBe(200);
    expect(await h.vector.query(subjectNamespace(OTHER_TENANT, GUEST_ANON), { text: "", k: 10 })).toHaveLength(1);
    expect(await h.registry.lookupByTenantId(OTHER_TENANT)).not.toBeNull();
  });

  it("an ARMED KILL SWITCH stops the destructive act but does NOT lose the obligation", async () => {
    const h = await harness();
    await seedMerchant(h.registry);
    await h.vector.upsert(subjectNamespace(TENANT, ACCOUNT_SUBJECT), [{ id: "f1", text: "a stored fact" }]);
    await recordSubject(h.store, { tenantId: TENANT, subject: ACCOUNT_SUBJECT });
    const scope = `tenant:${TENANT}`;
    await armKill(h.store, scope, "incident");
    try {
      // 200, because a non-2xx burns Shopify's 8 retries and can delete the compliance subscription —
      // losing the obligation entirely. The obligation is RECORDED instead.
      const res = await h.post(WEBHOOK_ROUTES.shopRedact, { raw: shopRedactBody(), topic: "shop/redact" });
      expect(res.statusCode).toBe(200);
      expect(await h.vector.query(subjectNamespace(TENANT, ACCOUNT_SUBJECT), { text: "", k: 10 })).toHaveLength(1);
      const rec = (await auditFor(h.store, TENANT)).find((r) => r.action === "shop.redact_deferred");
      expect(rec, "a halted erasure must leave an auditable, dated obligation").toBeTruthy();
      expect(rec!.reversalPath).toBeTruthy();
    } finally {
      await disarmKill(h.store, scope);
    }
  });
});

// ---------------------------------------------------------------------------------------------------
describe("C2 — customers/redact erases the one thing it can reach, and says what it cannot", () => {
  it("erases the ACCOUNT subject's memory namespace and nothing else", async () => {
    const h = await harness();
    await seedMerchant(h.registry);
    await h.vector.upsert(subjectNamespace(TENANT, ACCOUNT_SUBJECT), [{ id: "mine", text: "my fact" }]);
    await h.vector.upsert(subjectNamespace(TENANT, OTHER_ACCOUNT_SUBJECT), [{ id: "theirs", text: "another customer" }]);
    await h.vector.upsert(subjectNamespace(TENANT, GUEST_ANON), [{ id: "guest", text: "an unlinkable guest fact" }]);
    await recordSubject(h.store, { tenantId: TENANT, subject: ACCOUNT_SUBJECT });

    const res = await h.post(WEBHOOK_ROUTES.customersRedact, { raw: customerRedactBody(), topic: "customers/redact" });
    expect(res.statusCode).toBe(200);

    expect(await h.vector.query(subjectNamespace(TENANT, ACCOUNT_SUBJECT), { text: "", k: 10 })).toHaveLength(0);
    expect(await h.vector.query(subjectNamespace(TENANT, OTHER_ACCOUNT_SUBJECT), { text: "", k: 10 })).toHaveLength(1);
    // The honest limit: a guest namespace has NO link to a Shopify customer id, so it survives.
    expect(await h.vector.query(subjectNamespace(TENANT, GUEST_ANON), { text: "", k: 10 })).toHaveLength(1);
    // ...and the index entry for the erased subject is retired, so the sweep stops pointing at it.
    expect((await listSubjects(h.store, TENANT)).map((s) => s.subject)).not.toContain(ACCOUNT_SUBJECT);
  });

  it("does NOT revoke the merchant — a customer redaction is not a shop redaction", async () => {
    const h = await harness();
    await seedMerchant(h.registry);
    await h.post(WEBHOOK_ROUTES.customersRedact, { raw: customerRedactBody(), topic: "customers/redact" });
    expect(await h.registry.lookupByTenantId(TENANT)).not.toBeNull();
  });

  it("audits `complete: false` and names the residual (traffic log, guest namespaces)", async () => {
    const h = await harness();
    await seedMerchant(h.registry);
    await h.post(WEBHOOK_ROUTES.customersRedact, { raw: customerRedactBody(), topic: "customers/redact" });
    const rec = (await auditFor(h.store, TENANT)).find((r) => r.action === "customer.redact_applied");
    expect(rec).toBeTruthy();
    const decision = rec!.decision as { complete?: unknown; notErased?: unknown };
    expect(decision.complete).toBe(false);
    const notErased = (decision.notErased as string[]).join(" ");
    expect(notErased).toMatch(/traffic/i);
    expect(notErased).toMatch(/guest/i);
  });

  it("still works (and stays inert-safe) for an ALREADY uninstalled merchant", async () => {
    // shop/redact arrives 48h after uninstall, and app/uninstalled has already made every default
    // lookup return null. An erasure path that used a default lookup would silently do nothing.
    const h = await harness();
    await seedMerchant(h.registry);
    await h.registry.setStatus(TENANT, "uninstalled", { reason: "app/uninstalled webhook" });
    await h.vector.upsert(subjectNamespace(TENANT, ACCOUNT_SUBJECT), [{ id: "mine", text: "my fact" }]);
    const res = await h.post(WEBHOOK_ROUTES.customersRedact, { raw: customerRedactBody(), topic: "customers/redact" });
    expect(res.statusCode).toBe(200);
    expect(await h.vector.query(subjectNamespace(TENANT, ACCOUNT_SUBJECT), { text: "", k: 10 })).toHaveLength(0);
  });

  it("is IDEMPOTENT: a redelivery acts once and audits once", async () => {
    const h = await harness();
    await seedMerchant(h.registry);
    const raw = customerRedactBody();
    const id = nextWebhookId();
    await h.post(WEBHOOK_ROUTES.customersRedact, { raw, topic: "customers/redact", webhookId: id });
    await h.post(WEBHOOK_ROUTES.customersRedact, { raw, topic: "customers/redact", webhookId: id });
    expect((await auditFor(h.store, TENANT)).filter((r) => r.action === "customer.redact_applied")).toHaveLength(1);
  });

  it("a non-numeric customer id is refused rather than coerced into a namespace", async () => {
    const h = await harness();
    await seedMerchant(h.registry);
    for (const id of ["../../etc", "1::2", "", null, {}]) {
      const raw = customerRedactBody({ customer: { id, email: CUSTOMER_EMAIL } });
      const res = await h.post(WEBHOOK_ROUTES.customersRedact, { raw, topic: "customers/redact" });
      expect(res.statusCode, `customer.id=${JSON.stringify(id)} must be refused`).toBe(400);
    }
  });

  it("an ARMED KILL SWITCH stops the destructive act and records the obligation", async () => {
    const h = await harness();
    await seedMerchant(h.registry);
    await h.vector.upsert(subjectNamespace(TENANT, ACCOUNT_SUBJECT), [{ id: "f1", text: "a fact" }]);
    const scope = `tenant:${TENANT}`;
    await armKill(h.store, scope, "incident");
    try {
      const res = await h.post(WEBHOOK_ROUTES.customersRedact, { raw: customerRedactBody(), topic: "customers/redact" });
      expect(res.statusCode).toBe(200);
      expect(await h.vector.query(subjectNamespace(TENANT, ACCOUNT_SUBJECT), { text: "", k: 10 })).toHaveLength(1);
      expect((await auditFor(h.store, TENANT)).some((r) => r.action === "customer.redact_deferred")).toBe(true);
    } finally {
      await disarmKill(h.store, scope);
    }
  });
});

// ---------------------------------------------------------------------------------------------------
describe("C2 — customers/data_request is ACKNOWLEDGED-ONLY and must not pretend otherwise", () => {
  it("erases NOTHING — a data request is an access request, and deleting on one would be a disaster", async () => {
    const h = await harness();
    await seedMerchant(h.registry);
    await h.vector.upsert(subjectNamespace(TENANT, ACCOUNT_SUBJECT), [{ id: "mine", text: "my fact" }]);
    await h.store.append({ tenantId: TENANT }, "traffic", { message: "hi", reply: "hello" });
    const res = await h.post(WEBHOOK_ROUTES.customersDataRequest, { raw: dataRequestBody(), topic: "customers/data_request" });
    expect(res.statusCode).toBe(200);
    expect(await h.vector.query(subjectNamespace(TENANT, ACCOUNT_SUBJECT), { text: "", k: 10 })).toHaveLength(1);
    expect(await h.store.readStream({ tenantId: TENANT }, "traffic")).toHaveLength(1);
    expect(await h.registry.lookupByTenantId(TENANT)).not.toBeNull();
  });

  it("records a durable, dated obligation an operator can list — a 200 that means RECORDED, not IGNORED", async () => {
    const h = await harness();
    await seedMerchant(h.registry);
    await h.post(WEBHOOK_ROUTES.customersDataRequest, { raw: dataRequestBody(), topic: "customers/data_request" });
    const rows = await h.store.list<{ dueBy?: string; fulfilled?: unknown }>({ tenantId: TENANT }, DATA_REQUEST_COLLECTION);
    expect(rows, "the obligation must be durably recorded, not just logged").toHaveLength(1);
    // Shopify's own window: "Complete the action within 30 days of receiving the request."
    expect(typeof rows[0].value.dueBy).toBe("string");
    expect(Date.parse(rows[0].value.dueBy as string)).toBeGreaterThan(Date.now());
  });

  it("audits `fulfilled: false` and states plainly that no export capability exists", async () => {
    const h = await harness();
    await seedMerchant(h.registry);
    await h.post(WEBHOOK_ROUTES.customersDataRequest, { raw: dataRequestBody(), topic: "customers/data_request" });
    const rec = (await auditFor(h.store, TENANT)).find((r) => r.action === "data_request.acknowledged");
    expect(rec).toBeTruthy();
    const decision = rec!.decision as { fulfilled?: unknown; reason?: unknown };
    expect(decision.fulfilled).toBe(false);
    expect(String(decision.reason)).toMatch(/export/i);
  });

  it("is IDEMPOTENT: a redelivery records one obligation and audits once", async () => {
    const h = await harness();
    await seedMerchant(h.registry);
    const raw = dataRequestBody();
    const id = nextWebhookId();
    await h.post(WEBHOOK_ROUTES.customersDataRequest, { raw, topic: "customers/data_request", webhookId: id });
    await h.post(WEBHOOK_ROUTES.customersDataRequest, { raw, topic: "customers/data_request", webhookId: id });
    expect((await auditFor(h.store, TENANT)).filter((r) => r.action === "data_request.acknowledged")).toHaveLength(1);
    expect(await h.store.list({ tenantId: TENANT }, DATA_REQUEST_COLLECTION)).toHaveLength(1);
  });

  it("the recorded obligation holds NO raw customer identifier", async () => {
    const h = await harness();
    await seedMerchant(h.registry);
    await h.post(WEBHOOK_ROUTES.customersDataRequest, { raw: dataRequestBody(), topic: "customers/data_request" });
    const rows = await h.store.list({ tenantId: TENANT }, DATA_REQUEST_COLLECTION);
    expectNothingLeaked(JSON.stringify(rows), "the recorded data-request obligation");
  });
});

// ---------------------------------------------------------------------------------------------------
describe("C2 — nothing leaks: not the body, not the HMAC, not a customer identifier", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  let log: ReturnType<typeof vi.spyOn>;
  const lines: string[] = [];
  const sink = (...args: unknown[]) => void lines.push(args.map(String).join(" "));

  beforeEach(() => {
    lines.length = 0;
    warn = vi.spyOn(console, "warn").mockImplementation(sink);
    error = vi.spyOn(console, "error").mockImplementation(sink);
    log = vi.spyOn(console, "log").mockImplementation(sink);
  });
  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
    log.mockRestore();
  });

  it("no response body, audit record or log line carries a secret or a customer identifier", async () => {
    const h = await harness();
    await seedMerchant(h.registry);
    const bodies: string[] = [];

    // Success paths.
    bodies.push((await h.post(WEBHOOK_ROUTES.customersDataRequest, { raw: dataRequestBody(), topic: "customers/data_request" })).body);
    bodies.push((await h.post(WEBHOOK_ROUTES.customersRedact, { raw: customerRedactBody(), topic: "customers/redact" })).body);
    bodies.push((await h.post(WEBHOOK_ROUTES.shopRedact, { raw: shopRedactBody(), topic: "shop/redact" })).body);
    bodies.push((await h.post(WEBHOOK_ROUTES.appUninstalled, { raw: appUninstalledBody(), topic: "app/uninstalled" })).body);
    // Refusal paths — a distinguishable/verbose refusal is where secrets usually escape.
    bodies.push((await h.post(WEBHOOK_ROUTES.shopRedact, { raw: customerRedactBody(), topic: "shop/redact", hmac: "AAAA" })).body);
    bodies.push((await h.post(WEBHOOK_ROUTES.customersRedact, { raw: dataRequestBody(), topic: "customers/redact" })).body);

    for (const b of bodies) expectNothingLeaked(b, "a webhook response body");
    expectNothingLeaked(JSON.stringify(await auditFor(h.store, TENANT)), "the tenant audit chain");
    expectNothingLeaked(lines.join("\n"), "the server log");
    // The HMAC itself is never echoed either.
    const hmac = signBody(shopRedactBody());
    expect(lines.join("\n")).not.toContain(hmac);
    expect(bodies.join("\n")).not.toContain(hmac);
  });

  it("an internal failure is refused uniformly, with no error message reaching the response", async () => {
    // Fastify's default error handler puts `err.message` in the body. The handler must not let one out.
    const inner = new InMemoryRuntimeStore();
    const store: RuntimeStatePort = Object.assign(Object.create(Object.getPrototypeOf(inner)), inner, {
      audit: async () => {
        throw new Error(`audit unavailable: PALUP_SECRETS=${APP_SECRET}`);
      },
    }) as RuntimeStatePort;
    const registry = createInMemoryMerchantRegistry();
    const h = await harness({}, { store, registry });
    await seedMerchant(registry);
    const res = await h.post(WEBHOOK_ROUTES.appUninstalled, { raw: appUninstalledBody(), topic: "app/uninstalled" });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expectNothingLeaked(res.body, "a failed webhook response");
    // AUDIT-FIRST: an unauditable governed write must not persist.
    expect(await registry.lookupByTenantId(TENANT), "no unaudited revocation may land").not.toBeNull();
  });
});
