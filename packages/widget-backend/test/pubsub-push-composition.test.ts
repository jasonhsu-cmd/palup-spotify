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

// BUGFIX (stale-catalog-after-bulk-delete) — the catalog-reconcile push route must use the DEDICATED
// RL_PUBSUB_PUSH limiter (default 6000/min), NOT the shared 60/min RL_IP public-traffic bucket. Every
// Pub/Sub push egresses from ONE shared Google source IP, so a bulk product deletion fans out far more
// than 60 reconcile pushes/min into a single `ip:` counter → 429 → Pub/Sub retry → dead-letter → the
// delete-prune (reconcileProducts, catalog-index.ts "a requested id that did NOT come back is delisted →
// prune it") never runs → deleted products linger in vp_ann. This is the SAME §E4 property the memory push
// route already guards (pubsub-push-memory-composition.test.ts); the catalog route (#264) predates that
// fix and was never migrated to it.
//
// The rate-limit check runs BEFORE the OIDC verify (oidc-push-route.ts step 1), so flooding the REAL
// buildServer route with UNAUTHENTICATED posts exercises the actual server.ts wiring without a live/mocked
// verifier: past the 60/min RL_IP ceiling the shared bucket would 429 (bug), while the dedicated
// RL_PUBSUB_PUSH bucket (6000/min) still lets them through to the OIDC gate (401). Uses the shipped
// defaults (RL_IP=60 ≪ RL_PUBSUB_PUSH=6000) rather than an env override, because both limits are read into
// module-level consts at import (server.ts) and cannot be re-read per build.
describe("bulk-delete regression — the catalog push route uses the dedicated Pub/Sub limiter, not RL_IP (60/min)", () => {
  it("tolerates >60 pushes/min from one shared source IP: the 65th is 401 (OIDC gate), never 429 (RL_IP)", async () => {
    const app = await build({ ...PUBSUB_ENV });
    let last!: Awaited<ReturnType<typeof noAuthPost>>;
    for (let i = 0; i < 65; i++) last = await noAuthPost(app);
    // Fixed: dedicated 6000/min bucket ⇒ still refused at the OIDC gate (401).
    // Bug: shared 60/min RL_IP bucket ⇒ 429 by the 61st push (the failure this test guards against).
    expect(last.statusCode).toBe(401);
    await app.close();
  });
});
