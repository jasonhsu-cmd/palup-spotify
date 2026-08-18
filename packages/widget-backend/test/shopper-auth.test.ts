import { describe, it, expect, afterEach } from "vitest";
import { InMemoryRuntimeStore, mintShopperToken } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";
import { signAppProxyParams, SHOPIFY_APP_PROXY_SECRET_SCOPE, SHOPIFY_APP_PROXY_SECRET_NAME } from "../src/shopify-shopper-identity.js";

// ADR-0017 T4: /shopper/session mint + /chat shopper-token wiring behind SHOPPER_AUTH. Covers: a valid
// App-Proxy flow → shopper principal (audited, T8); a client-set shopperId is ignored; F1 cross-tenant
// re-binding degrades to anonymous; F4 (SHOPPER_AUTH needs WIDGET_AUTH_REQUIRED); off ⇒ unchanged.

const KEYS = [
  "WIDGET_TOKEN_SECRET", "WIDGET_EMBED_KEYS", "WIDGET_AUTH_REQUIRED", "WIDGET_TOKEN_TTL_SECONDS",
  "SHOPPER_AUTH", "SHOPPER_TOKEN_SECRET", "SHOPPER_TOKEN_TTL_SECONDS", "AUDIT_HMAC_SECRET",
  "PALUP_SECRETS", "SHOPIFY_STORES",
];
afterEach(() => KEYS.forEach((k) => delete process.env[k]));

const APP_SECRET = "app-proxy-secret";

function configureShopperAuth() {
  process.env.WIDGET_TOKEN_SECRET = "wsecret";
  process.env.WIDGET_AUTH_REQUIRED = "true";
  process.env.WIDGET_EMBED_KEYS = JSON.stringify({ "acme-key": "acme", "brandx-key": "brandx" });
  process.env.SHOPPER_AUTH = "true";
  process.env.SHOPPER_TOKEN_SECRET = "shopper-secret";
  process.env.SHOPIFY_STORES = JSON.stringify({ acme: "acme-store.myshopify.com", brandx: "brandx-store.myshopify.com" });
  process.env.PALUP_SECRETS = JSON.stringify({ [SHOPIFY_APP_PROXY_SECRET_SCOPE]: { [SHOPIFY_APP_PROXY_SECRET_NAME]: APP_SECRET } });
}

function signedAppProxyQuery(overrides: Record<string, string> = {}): string {
  const base = {
    shop: "acme-store.myshopify.com",
    logged_in_customer_id: "48291",
    timestamp: String(Math.floor(Date.now() / 1000)),
    path_prefix: "/apps/palup",
    ...overrides,
  };
  const signature = signAppProxyParams(APP_SECRET, base);
  return new URLSearchParams({ ...base, signature }).toString();
}

describe("ADR-0017 shopper auth wiring (T4)", () => {
  it("valid App-Proxy request → /shopper/session mints a token; /chat with it resolves a shopper principal (T8 audited, PII-safe)", async () => {
    configureShopperAuth();
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });

    const widgetToken = (await app.inject({ method: "GET", url: "/widget/token?key=acme-key" })).json().token as string;
    const sessionRes = await app.inject({
      method: "GET",
      url: `/shopper/session?${signedAppProxyQuery()}`,
      headers: { authorization: "Bearer " + widgetToken },
    });
    expect(sessionRes.statusCode).toBe(200);
    const shopperToken = sessionRes.json().token as string;
    expect(typeof shopperToken).toBe("string");

    const chatRes = await app.inject({
      method: "POST",
      url: "/chat",
      headers: { authorization: "Bearer " + widgetToken, "x-shopper-token": shopperToken },
      payload: { sessionId: "s1", message: "hi", signals: {} },
    });
    expect(chatRes.statusCode).toBe(200);

    const audit = await store.readAudit({ tenantId: "acme" });
    const identityEntry = audit.find((a) => a.action === "identity.shopper.resolved");
    expect(identityEntry).toBeTruthy();
    expect(identityEntry!.actor).toBe("system:identity");
    const serialized = JSON.stringify(identityEntry);
    expect(serialized).not.toContain("48291"); // the raw numeric customer id NEVER lands in the audit
    expect(serialized).not.toContain("shopify:acme:48291"); // nor the raw shopperId
    await app.close();
  });

  it("browsing (not logged in — no logged_in_customer_id) ⇒ /shopper/session returns no token, /chat stays anonymous", async () => {
    configureShopperAuth();
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });
    const widgetToken = (await app.inject({ method: "GET", url: "/widget/token?key=acme-key" })).json().token as string;
    const sessionRes = await app.inject({
      method: "GET",
      url: `/shopper/session?${signedAppProxyQuery({ logged_in_customer_id: "" })}`,
      headers: { authorization: "Bearer " + widgetToken },
    });
    expect(sessionRes.statusCode).toBe(200);
    expect(sessionRes.json().shopper).toBeNull();
    expect(sessionRes.json().token).toBeUndefined();
    await app.close();
  });

  it("a client-supplied signals.shopperId is ALWAYS ignored (falls back to the server-resolved/anonymous identity)", async () => {
    // Deliberately no SHOPPER_AUTH config at all — unauthenticated widget path (rollout default).
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "s2", message: "where's my order #1042?", signals: { shopperId: "evil-injected-id" } },
    });
    expect(res.statusCode).toBe(200);
    // signals.shopperId is server-ignored (invariant 4): the request is treated as anonymous. Since the
    // commerce port is the fixture-marked mock, the account-data question gets the honest fixture-guard
    // refusal — the SAME reply any anonymous shopper receives — and the injected id leaves no trace.
    // (Before the isFixtureData honesty fix this asserted the fallback demo order #1042 was stated as
    // fact; that fabrication now correctly refuses. The demo-order-stated path was the bug.)
    const body = res.json();
    expect(body.reply.toLowerCase()).toContain("can't look up your order or account details");
    expect(body.flags).toContain("account_lookup_unavailable");
    expect(body.escalate).toBe(true);
    expect(JSON.stringify(body)).not.toContain("evil-injected-id"); // client value never used
    await app.close();
  });

  it("F1 — a shopper token minted for a DIFFERENT tenant is degraded to anonymous at /chat (cross-tenant re-binding)", async () => {
    configureShopperAuth();
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });

    // Mint a shopper session bound to "brandx" via ITS OWN valid App-Proxy request.
    const brandxWidget = (await app.inject({ method: "GET", url: "/widget/token?key=brandx-key" })).json().token as string;
    const brandxSession = await app.inject({
      method: "GET",
      url: `/shopper/session?${signedAppProxyQuery({ shop: "brandx-store.myshopify.com" })}`,
      headers: { authorization: "Bearer " + brandxWidget },
    });
    const brandxShopperToken = brandxSession.json().token as string;
    expect(typeof brandxShopperToken).toBe("string");

    // Present that BRANDX shopper token on an ACME-authenticated /chat session.
    const acmeWidget = (await app.inject({ method: "GET", url: "/widget/token?key=acme-key" })).json().token as string;
    const chatRes = await app.inject({
      method: "POST",
      url: "/chat",
      headers: { authorization: "Bearer " + acmeWidget, "x-shopper-token": brandxShopperToken },
      payload: { sessionId: "s3", message: "hi", signals: {} },
    });
    expect(chatRes.statusCode).toBe(200);
    const acmeAudit = await store.readAudit({ tenantId: "acme" });
    expect(acmeAudit.find((a) => a.action === "identity.shopper.resolved")).toBeUndefined(); // degraded to anonymous, not bound cross-tenant
    await app.close();
  });

  it("F4 — SHOPPER_AUTH=true but WIDGET_AUTH_REQUIRED unset ⇒ /shopper/session is not honored (404)", async () => {
    process.env.SHOPPER_AUTH = "true";
    process.env.SHOPPER_TOKEN_SECRET = "shopper-secret";
    // WIDGET_AUTH_REQUIRED intentionally left unset — the F4 precondition is unmet.
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });
    const res = await app.inject({ method: "GET", url: "/shopper/session?shop=acme-store.myshopify.com" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("SHOPPER_AUTH off (default): /shopper/session is 404, and a well-formed shopper token is IGNORED at /chat — no behavior change", async () => {
    process.env.WIDGET_TOKEN_SECRET = "wsecret";
    process.env.WIDGET_AUTH_REQUIRED = "true";
    process.env.WIDGET_EMBED_KEYS = JSON.stringify({ "acme-key": "acme" });
    process.env.SHOPPER_TOKEN_SECRET = "shopper-secret";
    // SHOPPER_AUTH left unset (default off).
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });

    expect((await app.inject({ method: "GET", url: "/shopper/session" })).statusCode).toBe(404);

    const widgetToken = (await app.inject({ method: "GET", url: "/widget/token?key=acme-key" })).json().token as string;
    // A well-formed, correctly-tenant-matching shopper token minted directly (bypassing the disabled
    // endpoint) — even this must be ignored while the flag is off.
    const shopperToken = mintShopperToken("shopper-secret", "shopify:acme:1", "shopify", 300);
    const chatRes = await app.inject({
      method: "POST",
      url: "/chat",
      headers: { authorization: "Bearer " + widgetToken, "x-shopper-token": shopperToken },
      payload: { sessionId: "s4", message: "hi", signals: {} },
    });
    expect(chatRes.statusCode).toBe(200);
    const audit = await store.readAudit({ tenantId: "acme" });
    expect(audit.find((a) => a.action === "identity.shopper.resolved")).toBeUndefined();
    await app.close();
  });
});
