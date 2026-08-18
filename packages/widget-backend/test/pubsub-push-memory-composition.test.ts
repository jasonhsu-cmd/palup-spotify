import { describe, it, expect, afterEach } from "vitest";
import Fastify from "fastify";
import { InMemoryRuntimeStore, createInMemoryMerchantRegistry, createInMemoryVectorStore } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";
import { registerMemoryWritePushRoute, MEMORY_PUSH_ROUTE } from "../src/routes/pubsub-push-memory.js";
import { underLimit } from "../src/rate-limit.js";
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

// MEMORY-GO-LIVE-CHECKLIST.md §E4 — a DEDICATED rate limit for this route, not the shared 60/min RL_IP
// public-traffic limit (Pub/Sub pushes arrive from shared Google source IP ranges, so sharing RL_IP risks
// a false 429 → retry → dead-letter). `buildServer`'s own registration wraps the REAL google-auth-library
// OAuth2Client.verifyIdToken (server.ts's `memoryVerify`), which cannot be driven to an authorized 204
// without live Google network access or mocking that module — neither of which this suite does elsewhere
// (no existing test in this package mocks google-auth-library). So this test instead registers
// `registerMemoryWritePushRoute` DIRECTLY (as pubsub-push-memory.test.ts's own unit tests do, with an
// injected `verify`) but composes `checkRateLimit` EXACTLY the way server.ts does: the real `underLimit`
// helper over a real `InMemoryRuntimeStore`, keyed `ip:${ip}`, limited by `RL_PUBSUB_PUSH_PER_MIN` (falling
// back to server.ts's own 600/min default when unset) and `RL_WINDOW_SECONDS` (default 60) — the same two
// env knobs server.ts reads. This proves the composed dedicated-limiter property end to end without
// needing a live/mocked OIDC verifier: 600/min (or any value > 3) would never 429 three requests in one
// window, so a regression back to sharing the 60/min-but-still->3 RL_IP limit is not what's being guarded
// here — the low `RL_PUBSUB_PUSH_PER_MIN=2` override is what makes the 3rd request's 429 possible at all.
describe("MEMORY-GO-LIVE-CHECKLIST.md §E4 — the memory push route uses its OWN dedicated rate limit", () => {
  afterEach(() => delete process.env.RL_PUBSUB_PUSH_PER_MIN);

  it("RL_PUBSUB_PUSH_PER_MIN=2 ⇒ the 3rd authorized push in one window is 429 (not the 60/min RL_IP ceiling)", async () => {
    process.env.RL_PUBSUB_PUSH_PER_MIN = "2";
    const RL_PUBSUB_PUSH = Number(process.env.RL_PUBSUB_PUSH_PER_MIN);
    const RL_WINDOW_SECONDS = Number(process.env.RL_WINDOW_SECONDS ?? "60");
    const store = new InMemoryRuntimeStore();
    const f = Fastify();
    registerMemoryWritePushRoute(f, {
      verify: async () => ({ email: "pubsub-memory-push@proj.iam.gserviceaccount.com" }),
      expectedServiceAccount: "pubsub-memory-push@proj.iam.gserviceaccount.com",
      remember: async () => {},
      checkRateLimit: (ip) => underLimit(store, { tenantId: "__mint__" }, `pubsub-mem:${ip}`, RL_PUBSUB_PUSH, RL_WINDOW_SECONDS),
    });

    const body = {
      tenantId: "acme",
      anonId: "anon-1",
      region: "us",
      consent1: "in",
      consent2: "unknown",
      message: "m",
      reply: "r",
    };
    const payload = {
      message: { attributes: {}, data: Buffer.from(JSON.stringify(body), "utf8").toString("base64") },
    };
    const push = () => f.inject({ method: "POST", url: MEMORY_PUSH_ROUTE, headers: { authorization: "Bearer good" }, payload });

    const res1 = await push();
    const res2 = await push();
    const res3 = await push();

    expect(res1.statusCode).toBe(204);
    expect(res2.statusCode).toBe(204);
    expect(res3.statusCode).toBe(429);
  });

  // §E4 (security-review MED-2) — `underLimit` keys the fixed-window counter by (tenantId, key) only, so
  // the memory route MUST use its own key namespace or it shares one counter with the catalog push route
  // and all public `ip:` traffic. This proves the memory route's window is isolated: saturating the shared
  // `ip:${ip}` bucket for the same client IP does NOT make the memory route 429.
  it("MED-2 — the memory route's counter is isolated from the shared `ip:` bucket (dedicated key namespace)", async () => {
    const store = new InMemoryRuntimeStore();
    const f = Fastify();
    registerMemoryWritePushRoute(f, {
      verify: async () => ({ email: "pubsub-memory-push@proj.iam.gserviceaccount.com" }),
      expectedServiceAccount: "pubsub-memory-push@proj.iam.gserviceaccount.com",
      remember: async () => {},
      checkRateLimit: (ip) => underLimit(store, { tenantId: "__mint__" }, `pubsub-mem:${ip}`, 5, 60),
    });
    // Saturate the SHARED public `ip:` bucket (limit 1) for the default inject client IP (127.0.0.1),
    // well past its ceiling. If the memory route shared this counter it would now 429.
    for (let i = 0; i < 10; i++) await underLimit(store, { tenantId: "__mint__" }, "ip:127.0.0.1", 1, 60);
    const body = { tenantId: "acme", anonId: "a", region: "us", consent1: "in", consent2: "unknown", message: "m", reply: "r" };
    const payload = { message: { attributes: {}, data: Buffer.from(JSON.stringify(body), "utf8").toString("base64") } };
    const res = await f.inject({ method: "POST", url: MEMORY_PUSH_ROUTE, headers: { authorization: "Bearer good" }, payload });
    expect(res.statusCode).toBe(204); // unaffected by the exhausted `ip:` bucket — its own `pubsub-mem:` window
  });
});
