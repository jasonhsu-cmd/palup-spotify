import { describe, it, expect, afterEach } from "vitest";
import { InMemoryRuntimeStore, createInMemoryMerchantRegistry, createInMemoryVectorStore, mintWidgetToken } from "@palup/platform-ports";
import type { MerchantRegistryPort, RuntimeStatePort, VectorPort } from "@palup/platform-ports";
import { armKill, disarmKill } from "@palup/state-postgres";
import { buildServer } from "../src/server.js";

// Pillar 2a wiring — POST /cart/checkout-url. Turns the INERT CartPort + permalink adapter
// (platform-ports/src/cart-port.ts, cart-permalink-adapter.ts) into something the widget can call to
// build a multi-item Shopify checkout permalink. Mirrors /checkout/join-token's own gate/auth/rate-limit/
// kill-switch structure (checkout-join-token-route.test.ts is the precedent this file follows).
//
// Gated inert-by-absence behind IN_CHAT_CHECKOUT (default OFF ⇒ this route does not exist — 404, not a
// half-working 501/403). NO completion claim is made anywhere here: the response only ever hands back a
// checkout LINK the shopper still has to open and complete on Shopify themselves.

const TENANT = "demo"; // RUNTIME_TENANT fallback — no widget token needed when WIDGET_AUTH_REQUIRED is off
const WIDGET_SECRET = "wsecret";
const SHOP = "acme.myshopify.com";

const ENV_KEYS = ["IN_CHAT_CHECKOUT", "WIDGET_TOKEN_SECRET", "WIDGET_AUTH_REQUIRED", "WIDGET_EMBED_KEYS", "SHOPIFY_STORES"];
afterEach(() => ENV_KEYS.forEach((k) => delete process.env[k]));

interface Harness {
  app: Awaited<ReturnType<typeof buildServer>>;
  store: RuntimeStatePort;
  registry: MerchantRegistryPort;
  vector: VectorPort;
}

/** The fully-configured, ENABLED feature (IN_CHAT_CHECKOUT=true, a shop domain for TENANT). `over`
 *  removes/overrides env so the gating test can prove IN_CHAT_CHECKOUT is load-bearing on its own. */
async function harness(
  over: Record<string, string | undefined> = {},
  seams: { store?: RuntimeStatePort; registry?: MerchantRegistryPort } = {},
): Promise<Harness> {
  process.env.IN_CHAT_CHECKOUT = "true";
  process.env.SHOPIFY_STORES = JSON.stringify({ [TENANT]: SHOP });
  for (const [k, v] of Object.entries(over)) v === undefined ? delete process.env[k] : (process.env[k] = v);

  const store = seams.store ?? new InMemoryRuntimeStore();
  const registry = seams.registry ?? createInMemoryMerchantRegistry();
  const vector = createInMemoryVectorStore();
  const app = await buildServer({ store, merchantRegistry: registry, vectorPort: vector });
  return { app, store, registry, vector };
}

describe("POST /cart/checkout-url is inert unless IN_CHAT_CHECKOUT is on", () => {
  it("404s when IN_CHAT_CHECKOUT is unset — absent, not half-working", async () => {
    const h = await harness({ IN_CHAT_CHECKOUT: undefined });
    const res = await h.app.inject({
      method: "POST",
      url: "/cart/checkout-url",
      payload: { items: [{ variantId: "111", quantity: 1 }] },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /cart/checkout-url builds a multi-line Shopify checkout permalink", () => {
  it("200s with a checkoutUrl for two valid items", async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: "POST",
      url: "/cart/checkout-url",
      payload: {
        items: [
          { variantId: "111", quantity: 2 },
          { variantId: "222", quantity: 1 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { checkoutUrl: string };
    expect(body.checkoutUrl).toBe(`https://${SHOP}/cart/111:2,222:1`);
  });

  it("clamps a quantity above 99 down to the cap", async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: "POST",
      url: "/cart/checkout-url",
      payload: { items: [{ variantId: "111", quantity: 500 }] },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { checkoutUrl: string };
    expect(body.checkoutUrl).toBe(`https://${SHOP}/cart/111:99`);
  });

  it("defaults a missing/invalid quantity to 1 rather than dropping the line", async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: "POST",
      url: "/cart/checkout-url",
      payload: {
        items: [{ variantId: "111" }, { variantId: "222", quantity: 0 }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { checkoutUrl: string };
    expect(body.checkoutUrl).toBe(`https://${SHOP}/cart/111:1,222:1`);
  });
});

describe("POST /cart/checkout-url validation", () => {
  it("400s for an empty items array", async () => {
    const h = await harness();
    const res = await h.app.inject({ method: "POST", url: "/cart/checkout-url", payload: { items: [] } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "no valid items" });
  });

  it("400s when every item is invalid (missing/blank variantId)", async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: "POST",
      url: "/cart/checkout-url",
      payload: { items: [{ quantity: 1 }, { variantId: "   ", quantity: 2 }] },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "no valid items" });
  });

  it("400s 'checkout unavailable' when the tenant has no shop domain configured", async () => {
    const h = await harness({ SHOPIFY_STORES: JSON.stringify({}) });
    const res = await h.app.inject({
      method: "POST",
      url: "/cart/checkout-url",
      payload: { items: [{ variantId: "111", quantity: 1 }] },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "checkout unavailable" });
  });
});

describe("POST /cart/checkout-url tenant identity (T3), never a client-claimed tenant", () => {
  it("401s unauthenticated when WIDGET_AUTH_REQUIRED is true", async () => {
    const h = await harness({ WIDGET_AUTH_REQUIRED: "true", WIDGET_TOKEN_SECRET: WIDGET_SECRET });
    const res = await h.app.inject({
      method: "POST",
      url: "/cart/checkout-url",
      payload: { items: [{ variantId: "111", quantity: 1 }] },
    });
    expect(res.statusCode).toBe(401);
  });

  it("a merchant-scoped widget token resolves against THAT tenant's own shop domain", async () => {
    const OTHER_TENANT = "acme-store";
    const OTHER_SHOP = "acme-store.myshopify.com";
    const h = await harness({
      WIDGET_TOKEN_SECRET: WIDGET_SECRET,
      SHOPIFY_STORES: JSON.stringify({ [TENANT]: SHOP, [OTHER_TENANT]: OTHER_SHOP }),
    });
    const token = mintWidgetToken(WIDGET_SECRET, OTHER_TENANT, 3_600);
    const res = await h.app.inject({
      method: "POST",
      url: "/cart/checkout-url",
      payload: { items: [{ variantId: "111", quantity: 1 }], widgetToken: token },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { checkoutUrl: string };
    expect(body.checkoutUrl).toBe(`https://${OTHER_SHOP}/cart/111:1`);
  });
});

describe("POST /cart/checkout-url NN#4 kill switch", () => {
  it("503s while a tenant-scoped kill is armed, and no permalink is built", async () => {
    const h = await harness();
    await armKill(h.store, `tenant:${TENANT}`, "test halt");
    const res = await h.app.inject({
      method: "POST",
      url: "/cart/checkout-url",
      payload: { items: [{ variantId: "111", quantity: 1 }] },
    });
    expect(res.statusCode).toBe(503);

    await disarmKill(h.store, `tenant:${TENANT}`);
    const after = await h.app.inject({
      method: "POST",
      url: "/cart/checkout-url",
      payload: { items: [{ variantId: "111", quantity: 1 }] },
    });
    expect(after.statusCode).toBe(200);
  });
});

describe("POST /cart/checkout-url NN#5 audit — line count only, never a variantId or the URL", () => {
  it("writes one cart-checkout-url audit row carrying only the line count", async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: "POST",
      url: "/cart/checkout-url",
      payload: {
        // Long, DISTINCTIVE variant ids on purpose: the audit row also serializes a timestamp + seq, and a
        // SHORT numeric needle like "111" collides with those digits by chance — that was the #397 CI flake
        // (nothing actually leaked; the audit input is line-count-only, buildCartCheckoutAuditInput).
        items: [
          { variantId: "9876543210", quantity: 2 },
          { variantId: "8765432019", quantity: 1 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);

    const audit = await h.store.readAudit({ tenantId: TENANT });
    const row = audit.find((r) => r.action === "cart-checkout-url");
    expect(row, "expected a cart-checkout-url audit row").toBeDefined();
    expect(JSON.stringify(row)).not.toContain("9876543210");
    expect(JSON.stringify(row)).not.toContain("8765432019");
    expect(JSON.stringify(row)).not.toContain(SHOP);
    expect((row as { actor: string }).actor).toBe("shopper"); // no verified shopper on this request
  });
});
