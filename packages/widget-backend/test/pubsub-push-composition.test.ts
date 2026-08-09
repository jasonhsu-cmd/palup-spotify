import { describe, it, expect, afterEach } from "vitest";
import { InMemoryRuntimeStore, createInMemoryMerchantRegistry, createInMemoryVectorStore } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";
import { PUBSUB_PUSH_ROUTE } from "../src/routes/pubsub-push.js";
import { SHOPIFY_APP_CLIENT_SECRET_NAME, SHOPIFY_APP_SECRET_SCOPE } from "../src/shopify-install-identity.js";

// P4 — the OIDC push route must be registerable INDEPENDENTLY of CATALOG_WEBHOOKS, so an operator can
// smoke-verify its OIDC gate (the SOLE control on an internet-reachable, --allow-unauthenticated endpoint)
// BEFORE turning on the catalog webhook producer. The route is registered whenever the three Pub/Sub push
// settings are present; CATALOG_WEBHOOKS gates only the PUBLISH side (the webhook routes that enqueue).
// Property under test: route registration (401 vs 404) tracks PUBSUB_*, not CATALOG_WEBHOOKS.

const PUBSUB_ENV = {
  PUBSUB_CATALOG_TOPIC: "catalog-reconcile",
  PUBSUB_PUSH_SERVICE_ACCOUNT: "pubsub-catalog-push@proj.iam.gserviceaccount.com",
  PUBSUB_PUSH_AUDIENCE: "https://svc.example/internal/pubsub/catalog-reconcile",
};
const ENV_KEYS = ["PALUP_SECRETS", "CATALOG_WEBHOOKS", ...Object.keys(PUBSUB_ENV)];
afterEach(() => ENV_KEYS.forEach((k) => delete process.env[k]));

async function build(env: Record<string, string | undefined>) {
  process.env.PALUP_SECRETS = JSON.stringify({ [SHOPIFY_APP_SECRET_SCOPE]: { [SHOPIFY_APP_CLIENT_SECRET_NAME]: "shh" } });
  for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  return buildServer({
    store: new InMemoryRuntimeStore(),
    merchantRegistry: createInMemoryMerchantRegistry(),
    vectorPort: createInMemoryVectorStore(),
  });
}

// A tenant-less, no-auth POST: if the route is registered it fails CLOSED at the OIDC gate (401, no bearer);
// if it isn't registered at all Fastify returns 404. That 401-vs-404 is exactly "does the route exist".
async function noAuthPost(app: Awaited<ReturnType<typeof buildServer>>) {
  return app.inject({
    method: "POST",
    url: PUBSUB_PUSH_ROUTE,
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ message: { attributes: {} } }),
  });
}

describe("P4 push-route registration is decoupled from CATALOG_WEBHOOKS", () => {
  it("registers (401, not 404) when the PUBSUB_* trio is set even with CATALOG_WEBHOOKS OFF", async () => {
    const app = await build({ ...PUBSUB_ENV }); // CATALOG_WEBHOOKS unset
    const res = await noAuthPost(app);
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("does NOT register (404) when the PUBSUB_* trio is absent", async () => {
    const app = await build({}); // no Pub/Sub config
    const res = await noAuthPost(app);
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("still registers (401) when CATALOG_WEBHOOKS is ALSO on — decoupling did not break the coupled path", async () => {
    const app = await build({ ...PUBSUB_ENV, CATALOG_WEBHOOKS: "true" });
    const res = await noAuthPost(app);
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
