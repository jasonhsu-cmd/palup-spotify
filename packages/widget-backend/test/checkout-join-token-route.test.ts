import { describe, it, expect, afterEach } from "vitest";
import { InMemoryRuntimeStore, createInMemoryMerchantRegistry, createInMemoryVectorStore, mintWidgetToken } from "@palup/platform-ports";
import type { MerchantRegistryPort, RuntimeStatePort, VectorPort } from "@palup/platform-ports";
import { armKill, disarmKill } from "@palup/state-postgres";
import { buildServer } from "../src/server.js";
import { SHOPIFY_APP_CLIENT_SECRET_NAME, SHOPIFY_APP_SECRET_SCOPE } from "../src/shopify-install-identity.js";
import { assignHoldoutArm, holdoutIdentity, holdoutPeriod } from "../src/holdout.js";

// W3-3 — `POST /checkout/join-token`, exercised END TO END through the real Fastify app (mirroring
// shopify-webhook-routes.test.ts's own precedent for the sibling order-attribution surface): the mint
// endpoint the (out-of-scope here) widget checkout handoff will call to turn a shopper's already-assigned
// holdout arm into an opaque join token, PII-free, and DARK behind two independent gates:
//   1. ROUTE gate — ORDER_ATTRIBUTION_WEBHOOKS off ⇒ the route does not exist (404), same inert-by-absence
//      pattern the order/refund webhook routes already use.
//   2. PER-TENANT gate — `mintOrderJoinToken`'s own honest "nothing to mint" (204): the holdout is off for
//      this tenant, or this identity has no recorded assignment yet this period.

const APP_SECRET = "app-client-secret-never-logged";
const TENANT = "demo"; // RUNTIME_TENANT fallback — no widget token needed when WIDGET_AUTH_REQUIRED is off
const WIDGET_SECRET = "wsecret";

const ENV_KEYS = [
  "PALUP_SECRETS",
  "ORDER_ATTRIBUTION_WEBHOOKS",
  "WIDGET_TOKEN_SECRET",
  "WIDGET_AUTH_REQUIRED",
  "WIDGET_EMBED_KEYS",
  "SHOPIFY_STORES",
];
afterEach(() => ENV_KEYS.forEach((k) => delete process.env[k]));

interface Harness {
  app: Awaited<ReturnType<typeof buildServer>>;
  store: RuntimeStatePort;
  registry: MerchantRegistryPort;
  vector: VectorPort;
}

/** The fully-configured, ENABLED feature. `over` removes/overrides env so the gating test can prove the
 *  ORDER_ATTRIBUTION_WEBHOOKS precondition is load-bearing on its own. */
async function harness(
  over: Record<string, string | undefined> = {},
  seams: { store?: RuntimeStatePort; registry?: MerchantRegistryPort } = {},
): Promise<Harness> {
  process.env.PALUP_SECRETS = JSON.stringify({ [SHOPIFY_APP_SECRET_SCOPE]: { [SHOPIFY_APP_CLIENT_SECRET_NAME]: APP_SECRET } });
  process.env.ORDER_ATTRIBUTION_WEBHOOKS = "true";
  for (const [k, v] of Object.entries(over)) v === undefined ? delete process.env[k] : (process.env[k] = v);

  const store = seams.store ?? new InMemoryRuntimeStore();
  const registry = seams.registry ?? createInMemoryMerchantRegistry();
  const vector = createInMemoryVectorStore();
  const app = await buildServer({ store, merchantRegistry: registry, vectorPort: vector });
  return { app, store, registry, vector };
}

/** Enable the holdout for `tenantId` and bucket `identity` into an arm for the CURRENT period — the SAME
 *  primitive /chat's own serving path calls on a shopper's first turn this period. */
async function seedAssignment(store: RuntimeStatePort, tenantId: string, identity: string, fraction = 0): Promise<void> {
  const config = { enabled: true, fraction };
  await store.put({ tenantId }, "holdout", "config", config);
  await assignHoldoutArm(store, tenantId, config, identity, holdoutPeriod());
}

describe("W3-3 — POST /checkout/join-token is inert unless ORDER_ATTRIBUTION_WEBHOOKS is on", () => {
  it("404s when ORDER_ATTRIBUTION_WEBHOOKS is unset — absent, not half-working", async () => {
    const h = await harness({ ORDER_ATTRIBUTION_WEBHOOKS: undefined });
    const res = await h.app.inject({ method: "POST", url: "/checkout/join-token", payload: { sessionId: "s1" } });
    expect(res.statusCode).toBe(404);
  });
});

describe("W3-3 — the per-tenant dark gate: mintOrderJoinToken decides, the route never guesses", () => {
  it("204s with no token when the holdout is OFF for this tenant (nothing written)", async () => {
    const h = await harness();
    const res = await h.app.inject({ method: "POST", url: "/checkout/join-token", payload: { sessionId: "s1" } });
    expect(res.statusCode).toBe(204);
  });

  it("204s when the holdout is ON but this identity has no assignment yet this period (never reached /chat)", async () => {
    const h = await harness();
    await h.store.put({ tenantId: TENANT }, "holdout", "config", { enabled: true, fraction: 0.5 });
    const res = await h.app.inject({ method: "POST", url: "/checkout/join-token", payload: { sessionId: "never-chatted" } });
    expect(res.statusCode).toBe(204);
  });

  it("200s with a real opaque joinToken when the holdout is ON and this identity was already bucketed", async () => {
    const h = await harness();
    const sessionId = "s-real-assignment";
    const identity = holdoutIdentity({ sessionId });
    await seedAssignment(h.store, TENANT, identity);

    const res = await h.app.inject({ method: "POST", url: "/checkout/join-token", payload: { sessionId } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; joinToken: string };
    expect(body.ok).toBe(true);
    expect(typeof body.joinToken).toBe("string");
    expect(body.joinToken.length).toBeGreaterThan(10);
  });

  it("a DIFFERENT sessionId (a different identity) for the same tenant still gets 204 — no cross-shopper leak of a token", async () => {
    const h = await harness();
    await seedAssignment(h.store, TENANT, holdoutIdentity({ sessionId: "shopper-a" }));
    const res = await h.app.inject({ method: "POST", url: "/checkout/join-token", payload: { sessionId: "shopper-b" } });
    expect(res.statusCode).toBe(204);
  });
});

describe("W3-3 — no PII in the response or the audit trail", () => {
  it("the response never contains the raw sessionId, and the mint audit row carries only period/arm", async () => {
    const h = await harness();
    const sessionId = "s-pii-check-should-never-appear";
    const identity = holdoutIdentity({ sessionId });
    await seedAssignment(h.store, TENANT, identity);

    const res = await h.app.inject({ method: "POST", url: "/checkout/join-token", payload: { sessionId } });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(sessionId);

    const audit = await h.store.readAudit({ tenantId: TENANT });
    const mintRow = audit.find((r) => r.action === "order_jointoken.mint");
    expect(mintRow, "expected a mint audit row").toBeDefined();
    expect(JSON.stringify(mintRow)).not.toContain(sessionId);
    // The token itself must never be audited either (order-join-token.ts's own rule).
    const body = JSON.parse(res.body) as { joinToken: string };
    expect(JSON.stringify(mintRow)).not.toContain(body.joinToken);
  });
});

describe("W3-3 — NN#4 kill switch stops the mint (off /chat's own hot path, so this costs nothing to serve)", () => {
  it("503s while a tenant-scoped kill is armed, and mints nothing", async () => {
    const h = await harness();
    const sessionId = "s-halted";
    await seedAssignment(h.store, TENANT, holdoutIdentity({ sessionId }));
    await armKill(h.store, `tenant:${TENANT}`, "test halt");

    const res = await h.app.inject({ method: "POST", url: "/checkout/join-token", payload: { sessionId } });
    expect(res.statusCode).toBe(503);

    await disarmKill(h.store, `tenant:${TENANT}`);
    const after = await h.app.inject({ method: "POST", url: "/checkout/join-token", payload: { sessionId } });
    expect(after.statusCode).toBe(200);
  });
});

describe("W3-3 — tenant resolution reuses the widget-token pattern (T3), never a client-claimed tenant", () => {
  it("a merchant-scoped widget token mints against THAT tenant, not the RUNTIME_TENANT fallback", async () => {
    process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
    const OTHER_TENANT = "acme-store";
    const h = await harness();
    const token = mintWidgetToken(WIDGET_SECRET, OTHER_TENANT, 3_600);
    const sessionId = "s-other-tenant";
    await seedAssignment(h.store, OTHER_TENANT, holdoutIdentity({ sessionId }));

    // No assignment for TENANT ("demo") under this sessionId ⇒ would be 204 if resolved there.
    const res = await h.app.inject({
      method: "POST",
      url: "/checkout/join-token",
      payload: { sessionId, widgetToken: token },
    });
    expect(res.statusCode).toBe(200);
  });
});
