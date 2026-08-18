import { describe, it, expect, afterEach } from "vitest";
import { InMemoryRuntimeStore, createInMemoryMerchantRegistry, createInMemoryVectorStore } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";
import { MEMORY_PUSH_ROUTE } from "../src/routes/pubsub-push-memory.js";
import { SHOPIFY_APP_CLIENT_SECRET_NAME, SHOPIFY_APP_SECRET_SCOPE } from "../src/shopify-install-identity.js";

// #126 W1.5 — mirrors pubsub-push-composition.test.ts's property for the catalog route: registration
// (401 vs 404) tracks whether the route is WIRED, not any auth outcome. For the memory-write push route the
// wiring gate is TWO-PART (unlike the catalog route's PUBSUB_* trio alone): the MEMORY_PUBSUB_* trio AND
// memoryServiceEnabled (memory's own ADR-0015 double gate / the opts.memoryEnabled test seam) must BOTH be
// live — a durable queue for a feature that is itself off would register a route with nothing legitimate to
// write, and dark-by-default (memoryServiceEnabled false in real production) must keep this route absent
// regardless of what Pub/Sub env happens to be set.

const MEMORY_PUBSUB_ENV = {
  MEMORY_PUBSUB_TOPIC: "memory-write",
  MEMORY_PUBSUB_PUSH_SERVICE_ACCOUNT: "pubsub-memory-push@proj.iam.gserviceaccount.com",
  MEMORY_PUBSUB_PUSH_AUDIENCE: "https://svc.example/internal/pubsub/memory-write",
};
const ENV_KEYS = ["PALUP_SECRETS", "WIDGET_AUTH_REQUIRED", ...Object.keys(MEMORY_PUBSUB_ENV)];
afterEach(() => ENV_KEYS.forEach((k) => delete process.env[k]));

async function build(env: Record<string, string | undefined>, memoryEnabled?: boolean) {
  process.env.PALUP_SECRETS = JSON.stringify({ [SHOPIFY_APP_SECRET_SCOPE]: { [SHOPIFY_APP_CLIENT_SECRET_NAME]: "shh" } });
  // assertMemoryAuthCoupling (server.ts) refuses to boot with memory live and WIDGET_AUTH_REQUIRED unset —
  // an enablement precondition unrelated to this task, so it is satisfied here rather than tested against.
  if (memoryEnabled) process.env.WIDGET_AUTH_REQUIRED = "true";
  for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  return buildServer({
    store: new InMemoryRuntimeStore(),
    merchantRegistry: createInMemoryMerchantRegistry(),
    vectorPort: createInMemoryVectorStore(),
    ...(memoryEnabled !== undefined ? { memoryEnabled } : {}),
  });
}

// A tenant-less, no-auth POST: if the route is registered it fails CLOSED at the OIDC gate (401, no bearer);
// if it isn't registered at all Fastify returns 404. That 401-vs-404 is exactly "does the route exist".
async function noAuthPost(app: Awaited<ReturnType<typeof buildServer>>) {
  return app.inject({
    method: "POST",
    url: MEMORY_PUSH_ROUTE,
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ message: { attributes: {} } }),
  });
}

describe("#126 — memory-write push-route registration requires MEMORY_PUBSUB_* AND memory live", () => {
  it("registers (401, not 404) when the MEMORY_PUBSUB_* trio is set AND memoryEnabled is true", async () => {
    const app = await build({ ...MEMORY_PUBSUB_ENV }, true);
    const res = await noAuthPost(app);
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("does NOT register (404) when the MEMORY_PUBSUB_* trio is absent, even with memoryEnabled true", async () => {
    const app = await build({}, true);
    const res = await noAuthPost(app);
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("does NOT register (404) when the trio is set but memory is NOT live (memoryEnabled false/default)", async () => {
    const app = await build({ ...MEMORY_PUBSUB_ENV }, false);
    const res = await noAuthPost(app);
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("does NOT register (404) when memoryEnabled is left at its default (real-production double gate off) even with the trio set", async () => {
    const app = await build({ ...MEMORY_PUBSUB_ENV }); // no memoryEnabled override at all
    const res = await noAuthPost(app);
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
