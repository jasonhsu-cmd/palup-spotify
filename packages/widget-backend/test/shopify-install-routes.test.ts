import { describe, it, expect, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { InMemoryRuntimeStore, createInMemoryMerchantRegistry } from "@palup/platform-ports";
import type { AuditRecord, MerchantRegistryPort, RuntimeStatePort } from "@palup/platform-ports";
import { armKill, disarmKill } from "@palup/state-postgres";
import { buildServer } from "../src/server.js";
import { SHOPIFY_APP_CLIENT_SECRET_NAME, SHOPIFY_APP_SECRET_SCOPE } from "../src/shopify-install-identity.js";
import {
  INSTALL_APP_SCOPE,
  INSTALL_PENDING_COLLECTION,
  INSTALL_STATE_COOKIE,
  type MerchantCredentialSink,
} from "../src/routes/shopify-install.js";

// C1 — GET /shopify/install → GET /shopify/callback → delegateAccessTokenCreate, exercised END TO END
// through the real Fastify app, because the callback is ATTACKER-REACHABLE: every parameter (`shop`,
// `code`, `state`, `hmac`, `host`, `timestamp`) arrives from an external redirect. Driving it through
// `app.inject` is the point — a unit test on the flow function would not prove the ROUTE validates before
// it trusts.
//
// The properties this file exists to hold, in priority order:
//   1. NOTHING IS TRUSTED BEFORE THE HMAC. A callback without a valid app-secret HMAC writes no merchant
//      row, stores no credential, makes no outbound Shopify call and appends no audit record.
//   2. CSRF/replay. `state` is server-minted, single-use, expiring, bound to ONE shop, and compared in
//      constant time against the HttpOnly cookie set at install time.
//   3. NO SECRET EVER REACHES A RESPONSE, A LOG, AN ERROR OR AN AUDIT RECORD. Asserted against the FULL
//      JSON of every audit record and the full body of every response — the style B2 (#186) uses.
//   4. FAIL CLOSED. Unknown shop, bad HMAC, replayed state, missing credential custody, armed kill: all
//      refuse. Nothing ever falls back to the `demo` tenant (#169).

const SHOP = "acme-store.myshopify.com";
const OTHER_SHOP = "beta-store.myshopify.com";
const APP_SECRET = "app-client-secret-never-logged";
const CLIENT_ID = "client-123";
const REDIRECT_URI = "https://widget.palup.ai/shopify/callback";
const PARENT_TOKEN = "shpat_PARENT_TOKEN_NEVER_LOGGED_0001";
const DELEGATE_TOKEN = "shpca_DELEGATE_TOKEN_NEVER_LOGGED_0002";
const AUTH_CODE = "authorization-code-never-logged-0003";
const GRANTED_SCOPES = "unauthenticated_read_product_listings";

const ENV_KEYS = [
  "SHOPIFY_APP_CLIENT_ID",
  "SHOPIFY_INSTALL_REDIRECT_URI",
  "SHOPIFY_INSTALL_REGION",
  "SHOPIFY_INSTALL_SCOPES",
  "SHOPIFY_DELEGATE_SCOPES",
  "PALUP_SECRETS",
  "WIDGET_EMBED_KEYS",
  "SHOPIFY_STORES",
];
afterEach(() => ENV_KEYS.forEach((k) => delete process.env[k]));

/** Sign a query exactly as Shopify does for admin/OAuth requests (see shopify-install-identity.ts cites). */
function sign(query: Record<string, string>, secret = APP_SECRET): string {
  const sp = new URLSearchParams();
  for (const k of Object.keys(query).filter((x) => x !== "hmac" && x !== "signature").sort((a, b) => a.localeCompare(b))) {
    sp.append(k, query[k]);
  }
  return createHmac("sha256", secret).update(sp.toString().replace(/\+/g, "%20")).digest("hex");
}

function qs(query: Record<string, string>, opts: { secret?: string; hmac?: string | null } = {}): string {
  const hmac = opts.hmac === null ? undefined : (opts.hmac ?? sign(query, opts.secret ?? APP_SECRET));
  const sp = new URLSearchParams(query);
  if (hmac !== undefined) sp.set("hmac", hmac);
  return sp.toString();
}

/** In-memory stand-in for B2's `MerchantCredentialStore` (#186, not merged): records what was custodied. */
function recordingSink(): MerchantCredentialSink & { puts: Array<{ tenantId: string; token: string; actor: string }>; failNext?: boolean } {
  const puts: Array<{ tenantId: string; token: string; actor: string }> = [];
  const sink = {
    puts,
    failNext: false,
    async put(tenantId: string, token: string, opts: { actor: string }) {
      if (sink.failNext) throw new Error("credential store unavailable");
      puts.push({ tenantId, token, actor: opts.actor });
    },
  };
  return sink;
}

interface Harness {
  app: Awaited<ReturnType<typeof buildServer>>;
  store: RuntimeStatePort;
  registry: MerchantRegistryPort;
  sink: ReturnType<typeof recordingSink>;
  fetchCalls: string[];
  setFetch: (fn: (url: string, init?: RequestInit) => unknown) => void;
}

/**
 * The fully-configured, ENABLED install feature. `over` removes/overrides one env var at a time so the
 * gating tests prove each precondition is individually load-bearing.
 */
async function harness(
  over: Record<string, string | undefined> = {},
  seams: { registry?: MerchantRegistryPort; sink?: MerchantCredentialSink | null; store?: RuntimeStatePort } = {},
): Promise<Harness> {
  process.env.SHOPIFY_APP_CLIENT_ID = CLIENT_ID;
  process.env.SHOPIFY_INSTALL_REDIRECT_URI = REDIRECT_URI;
  process.env.SHOPIFY_INSTALL_REGION = "us";
  process.env.PALUP_SECRETS = JSON.stringify({ [SHOPIFY_APP_SECRET_SCOPE]: { [SHOPIFY_APP_CLIENT_SECRET_NAME]: APP_SECRET } });
  for (const [k, v] of Object.entries(over)) v === undefined ? delete process.env[k] : (process.env[k] = v);

  const store = seams.store ?? new InMemoryRuntimeStore();
  const registry = seams.registry ?? createInMemoryMerchantRegistry();
  const sink = recordingSink();
  const fetchCalls: string[] = [];
  let impl: (url: string, init?: RequestInit) => unknown = (url) => {
    if (url.endsWith("/admin/oauth/access_token")) {
      return { ok: true, status: 200, json: async () => ({ access_token: PARENT_TOKEN, scope: GRANTED_SCOPES }) };
    }
    if (url.includes("/graphql.json")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            delegateAccessTokenCreate: {
              delegateAccessToken: { accessToken: DELEGATE_TOKEN, accessScopes: [GRANTED_SCOPES] },
              userErrors: [],
            },
          },
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const installFetch = (async (url: unknown, init?: unknown) => {
    fetchCalls.push(String(url));
    return impl(String(url), init as RequestInit);
  }) as unknown as typeof globalThis.fetch;

  const app = await buildServer({
    store,
    installFetch,
    merchantRegistry: registry,
    merchantCredentials: seams.sink === null ? undefined : (seams.sink ?? sink),
  });
  return { app, store, registry, sink, fetchCalls, setFetch: (fn) => (impl = fn) };
}

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const first = Array.isArray(raw) ? raw[0] : (raw as string | undefined);
  expect(first, "install must set the state cookie").toBeTruthy();
  return String(first).split(";")[0];
}

/** Begin an install and return the minted state + the cookie the browser would send back. */
async function begin(h: Harness, shop = SHOP): Promise<{ state: string; cookie: string; res: Awaited<ReturnType<Harness["app"]["inject"]>> }> {
  const res = await h.app.inject({
    method: "GET",
    url: `/shopify/install?${qs({ shop, timestamp: String(Math.floor(Date.now() / 1000)) })}`,
  });
  expect(res.statusCode).toBe(302);
  const state = new URL(res.headers.location as string).searchParams.get("state")!;
  return { state, cookie: cookieFrom(res as unknown as { headers: Record<string, unknown> }), res };
}

async function callback(
  h: Harness,
  args: { state: string; cookie?: string; shop?: string; code?: string; hmac?: string | null; secret?: string; timestamp?: string; extra?: Record<string, string> },
) {
  const query: Record<string, string> = {
    code: args.code ?? AUTH_CODE,
    host: "YWNtZS1zdG9yZS5teXNob3BpZnkuY29tL2FkbWlu",
    shop: args.shop ?? SHOP,
    state: args.state,
    timestamp: args.timestamp ?? String(Math.floor(Date.now() / 1000)),
    ...(args.extra ?? {}),
  };
  return h.app.inject({
    method: "GET",
    url: `/shopify/callback?${qs(query, { secret: args.secret, hmac: args.hmac })}`,
    headers: args.cookie === undefined ? {} : { cookie: args.cookie },
  });
}

async function auditFor(store: RuntimeStatePort, tenantId: string): Promise<AuditRecord[]> {
  return store.readAudit({ tenantId });
}

/** Every secret-ish string this test knows about. None may appear anywhere observable. */
const SECRETS = [APP_SECRET, PARENT_TOKEN, DELEGATE_TOKEN, AUTH_CODE];

function expectNoSecrets(haystack: string, what: string): void {
  for (const s of SECRETS) expect(haystack, `${what} must not contain ${s.slice(0, 12)}…`).not.toContain(s);
}

// ---------------------------------------------------------------------------------------------------
describe("C1 gating — the install feature is inert unless FULLY configured", () => {
  it("both routes 404 when the app client id is unset", async () => {
    const h = await harness({ SHOPIFY_APP_CLIENT_ID: undefined });
    expect((await h.app.inject({ method: "GET", url: `/shopify/install?${qs({ shop: SHOP, timestamp: "1" })}` })).statusCode).toBe(404);
    expect((await h.app.inject({ method: "GET", url: `/shopify/callback?${qs({ shop: SHOP, timestamp: "1", code: "c", state: "s" })}` })).statusCode).toBe(404);
  });

  it("404 when the redirect URI is unset", async () => {
    const h = await harness({ SHOPIFY_INSTALL_REDIRECT_REDIRECT: undefined, SHOPIFY_INSTALL_REDIRECT_URI: undefined });
    expect((await h.app.inject({ method: "GET", url: `/shopify/install?${qs({ shop: SHOP, timestamp: "1" })}` })).statusCode).toBe(404);
  });

  it("404 when no residency region is declared — the registry REQUIRES one and we refuse to guess `us`", async () => {
    const h = await harness({ SHOPIFY_INSTALL_REGION: undefined });
    expect((await h.app.inject({ method: "GET", url: `/shopify/install?${qs({ shop: SHOP, timestamp: "1" })}` })).statusCode).toBe(404);
    const bad = await harness({ SHOPIFY_INSTALL_REGION: "atlantis" });
    expect((await bad.app.inject({ method: "GET", url: `/shopify/install?${qs({ shop: SHOP, timestamp: "1" })}` })).statusCode).toBe(404);
  });

  it("404 when the app client secret is not provisioned in the SecretsPort", async () => {
    const h = await harness({ PALUP_SECRETS: JSON.stringify({ other: { x: "y" } }) });
    expect((await h.app.inject({ method: "GET", url: `/shopify/install?${qs({ shop: SHOP, timestamp: "1" })}` })).statusCode).toBe(404);
  });

  it("404 when NO CREDENTIAL CUSTODY is wired — we refuse to complete an install we cannot store a token for", async () => {
    // This is the live production state while B2 (#186) is unmerged: no credential store ⇒ the feature is
    // OFF rather than half-working. An install that obtained a delegate token and then dropped it would be
    // a credential created at Shopify with no custody and no revocation path.
    const h = await harness({}, { sink: null });
    expect((await h.app.inject({ method: "GET", url: `/shopify/install?${qs({ shop: SHOP, timestamp: "1" })}` })).statusCode).toBe(404);
    expect((await h.app.inject({ method: "GET", url: `/shopify/callback?${qs({ shop: SHOP, timestamp: "1", code: "c", state: "s" })}` })).statusCode).toBe(404);
  });

  it("a 404'd callback writes nothing at all — no audit, no registry row, no outbound call", async () => {
    const h = await harness({ SHOPIFY_APP_CLIENT_ID: undefined });
    await h.app.inject({ method: "GET", url: `/shopify/callback?${qs({ shop: SHOP, timestamp: "1", code: "c", state: "s" })}` });
    expect(h.fetchCalls).toEqual([]);
    expect(await h.registry.lookupByShopDomain(SHOP, { includeInactive: true })).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------
describe("C1 GET /shopify/install — the installation request is itself verified", () => {
  it("a valid, signed install request 302s to the shop's own authorize URL and sets an HttpOnly state cookie", async () => {
    const h = await harness();
    const res = await h.app.inject({ method: "GET", url: `/shopify/install?${qs({ shop: SHOP, timestamp: String(Math.floor(Date.now() / 1000)) })}` });
    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers.location as string);
    expect(loc.origin).toBe(`https://${SHOP}`);
    expect(loc.pathname).toBe("/admin/oauth/authorize");
    expect(loc.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(loc.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(loc.searchParams.get("state")).toBeTruthy();
    expect(loc.searchParams.has("grant_options[]")).toBe(false); // offline token

    const cookie = String(Array.isArray(res.headers["set-cookie"]) ? res.headers["set-cookie"][0] : res.headers["set-cookie"]);
    expect(cookie).toContain(`${INSTALL_STATE_COOKIE}=`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Max-Age=\d+/i);
    // The cookie carries ONLY the state nonce — never the app secret.
    expectNoSecrets(cookie, "the state cookie");
  });

  it("the pending record is keyed by an unguessable state, bound to THIS shop, and TTL'd", async () => {
    const h = await harness();
    const { state } = await begin(h);
    expect(state.length).toBeGreaterThanOrEqual(32); // 32 random bytes, base64url
    const pending = await h.store.get<{ shopDomain: string }>({ tenantId: INSTALL_APP_SCOPE }, INSTALL_PENDING_COLLECTION, state);
    expect(pending?.shopDomain).toBe(SHOP);
    expect(JSON.stringify(pending)).not.toContain(APP_SECRET);
  });

  it("two installs mint DIFFERENT states (a fixed nonce would be no CSRF defence at all)", async () => {
    const h = await harness();
    const a = await begin(h);
    const b = await begin(h);
    expect(a.state).not.toBe(b.state);
  });

  it("REFUSES an unsigned / wrongly-signed installation request, and mints no state", async () => {
    const h = await harness();
    for (const bad of [
      qs({ shop: SHOP, timestamp: String(Math.floor(Date.now() / 1000)) }, { hmac: null }),
      qs({ shop: SHOP, timestamp: String(Math.floor(Date.now() / 1000)) }, { hmac: "deadbeef" }),
      qs({ shop: SHOP, timestamp: String(Math.floor(Date.now() / 1000)) }, { secret: "attacker-secret" }),
    ]) {
      const res = await h.app.inject({ method: "GET", url: `/shopify/install?${bad}` });
      expect(res.statusCode).toBe(400);
      expect(res.headers["set-cookie"]).toBeUndefined();
      expectNoSecrets(res.body, "the refusal body");
    }
    expect(await h.store.list({ tenantId: INSTALL_APP_SCOPE }, INSTALL_PENDING_COLLECTION)).toEqual([]);
  });

  it("REFUSES a non-myshopify shop even when the HMAC is valid — the allowlist is independent of the signature", async () => {
    const h = await harness();
    for (const shop of ["evil.test", "acme.myshopify.com.evil.test", "acme.myshopify.com/x", "acme.myshopify.com."]) {
      const res = await h.app.inject({ method: "GET", url: `/shopify/install?${qs({ shop, timestamp: String(Math.floor(Date.now() / 1000)) })}` });
      expect(res.statusCode, `expected refusal for ${shop}`).toBe(400);
    }
    expect(await h.store.list({ tenantId: INSTALL_APP_SCOPE }, INSTALL_PENDING_COLLECTION)).toEqual([]);
  });

  it("REFUSES a stale installation request (replay of a captured, validly-signed install link)", async () => {
    const h = await harness();
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    expect((await h.app.inject({ method: "GET", url: `/shopify/install?${qs({ shop: SHOP, timestamp: stale })}` })).statusCode).toBe(400);
  });

  it("REFUSES while a kill is armed at ANY scope — no new credential custody may begin during a halt (NN#4)", async () => {
    for (const scope of ["global", `tenant:acme-store`, "agent:shopper"] as const) {
      const h = await harness();
      await armKill(h.store, scope, "test");
      const res = await h.app.inject({ method: "GET", url: `/shopify/install?${qs({ shop: SHOP, timestamp: String(Math.floor(Date.now() / 1000)) })}` });
      expect(res.statusCode, `expected refusal under ${scope}`).toBe(400);
      expect(await h.store.list({ tenantId: INSTALL_APP_SCOPE }, INSTALL_PENDING_COLLECTION)).toEqual([]);
      await disarmKill(h.store, scope);
    }
  });
});

// ---------------------------------------------------------------------------------------------------
describe("C1 GET /shopify/callback — nothing is trusted before the HMAC", () => {
  it("a callback with NO valid HMAC writes nothing, calls nothing, audits nothing — even with a real state", async () => {
    const h = await harness();
    const { state, cookie } = await begin(h);
    h.fetchCalls.length = 0;

    for (const hmac of [null, "deadbeef", "0".repeat(64)] as Array<string | null>) {
      const res = await callback(h, { state, cookie, hmac });
      expect(res.statusCode).toBe(400);
      expectNoSecrets(res.body, "the refusal body");
    }
    // Signed with the WRONG secret, too.
    expect((await callback(h, { state, cookie, secret: "attacker-secret" })).statusCode).toBe(400);

    expect(h.fetchCalls).toEqual([]); // no token exchange, no delegate mutation
    expect(h.sink.puts).toEqual([]); // no credential custodied
    expect(await h.registry.lookupByShopDomain(SHOP, { includeInactive: true })).toBeNull();
    // …and the state is still unconsumed, so the legitimate merchant's install can still finish.
    expect(await h.store.get({ tenantId: INSTALL_APP_SCOPE }, INSTALL_PENDING_COLLECTION, state)).not.toBeNull();
  });

  it("REFUSES a validly-signed callback whose `shop` is not a myshopify host", async () => {
    const h = await harness();
    const { state, cookie } = await begin(h);
    for (const shop of ["evil.test", "acme.myshopify.com.evil.test", "acme.myshopify.com."]) {
      const res = await callback(h, { state, cookie, shop });
      expect(res.statusCode, `expected refusal for ${shop}`).toBe(400);
    }
    expect(h.fetchCalls.filter((u) => u.includes("oauth/access_token"))).toEqual([]);
  });

  it("REFUSES a state minted for shop A when replayed with shop B (cross-shop binding)", async () => {
    const h = await harness();
    const { state, cookie } = await begin(h, SHOP);
    const res = await callback(h, { state, cookie, shop: OTHER_SHOP });
    expect(res.statusCode).toBe(400);
    expect(await h.registry.lookupByShopDomain(OTHER_SHOP, { includeInactive: true })).toBeNull();
    expect(await h.registry.lookupByShopDomain(SHOP, { includeInactive: true })).toBeNull();
  });

  it("REFUSES an unknown / expired / already-used state (single use, consumed exactly once)", async () => {
    const h = await harness();
    const { state, cookie } = await begin(h);
    expect((await callback(h, { state, cookie })).statusCode).toBe(200); // first use succeeds
    const replay = await callback(h, { state, cookie });
    expect(replay.statusCode).toBe(400); // …and the second is refused
    // Never registered twice, and only ONE credential put happened.
    expect(h.sink.puts).toHaveLength(1);

    const fresh = await harness();
    const begun = await begin(fresh);
    expect((await callback(fresh, { state: "a-state-nobody-minted", cookie: `${INSTALL_STATE_COOKIE}=a-state-nobody-minted` })).statusCode).toBe(400);
    // An unrelated forged state must not consume the real pending record.
    expect(await fresh.store.get({ tenantId: INSTALL_APP_SCOPE }, INSTALL_PENDING_COLLECTION, begun.state)).not.toBeNull();
  });

  it("REFUSES a missing cookie, a blank cookie, and a cookie that does not equal `state`", async () => {
    const h = await harness();
    const first = await begin(h);
    expect((await callback(h, { state: first.state })).statusCode).toBe(400); // no cookie at all
    const second = await begin(h);
    expect((await callback(h, { state: second.state, cookie: `${INSTALL_STATE_COOKIE}=` })).statusCode).toBe(400);
    const third = await begin(h);
    expect((await callback(h, { state: third.state, cookie: `${INSTALL_STATE_COOKIE}=${third.state.slice(0, -1)}x` })).statusCode).toBe(400);
    // A cookie from a DIFFERENT install must not satisfy this one.
    const a = await begin(h);
    const b = await begin(h);
    expect((await callback(h, { state: a.state, cookie: b.cookie })).statusCode).toBe(400);
    expect(h.sink.puts).toEqual([]);
  });

  it("REFUSES a stale or future callback timestamp", async () => {
    const h = await harness();
    for (const delta of [-3600, -91, 91, 3600]) {
      const { state, cookie } = await begin(h);
      const ts = String(Math.floor(Date.now() / 1000) + delta);
      expect((await callback(h, { state, cookie, timestamp: ts })).statusCode, `delta ${delta}`).toBe(400);
    }
    expect(h.sink.puts).toEqual([]);
  });

  it("REFUSES an extra attacker-appended parameter (it is covered by the signature, so the HMAC fails)", async () => {
    const h = await harness();
    const { state, cookie } = await begin(h);
    const query: Record<string, string> = { code: AUTH_CODE, shop: SHOP, state, timestamp: String(Math.floor(Date.now() / 1000)) };
    const hmac = sign(query);
    const res = await h.app.inject({
      method: "GET",
      url: `/shopify/callback?${new URLSearchParams({ ...query, hmac, evil: "1" }).toString()}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it("REFUSES a missing `code` even when everything else verifies", async () => {
    const h = await harness();
    const { state, cookie } = await begin(h);
    const query = { host: "aG9zdA", shop: SHOP, state, timestamp: String(Math.floor(Date.now() / 1000)) };
    const res = await h.app.inject({ method: "GET", url: `/shopify/callback?${qs(query)}`, headers: { cookie } });
    expect(res.statusCode).toBe(400);
    expect(h.fetchCalls.filter((u) => u.includes("oauth/access_token"))).toEqual([]);
  });

  it("REFUSES while a kill is armed at any scope, and custodies nothing (NN#4)", async () => {
    for (const scope of ["global", "agent:shopper"] as const) {
      const h = await harness();
      const { state, cookie } = await begin(h);
      await armKill(h.store, scope, "test");
      const res = await callback(h, { state, cookie });
      expect(res.statusCode, `expected refusal under ${scope}`).toBe(400);
      expect(h.sink.puts).toEqual([]);
      expect(await h.registry.lookupByShopDomain(SHOP, { includeInactive: true })).toBeNull();
      await disarmKill(h.store, scope);
    }
  });
});

// ---------------------------------------------------------------------------------------------------
describe("C1 the happy path — install → callback → delegateAccessTokenCreate", () => {
  it("exchanges the code, mints a DELEGATE token, custodies it, and registers the merchant", async () => {
    const h = await harness();
    const { state, cookie } = await begin(h);
    const res = await callback(h, { state, cookie });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");

    // Both outbound calls happened, in order, against the SHOP's own host.
    expect(h.fetchCalls[0]).toBe(`https://${SHOP}/admin/oauth/access_token`);
    expect(h.fetchCalls[1]).toContain(`https://${SHOP}/admin/api/`);
    expect(h.fetchCalls[1]).toContain("/graphql.json");

    // The DELEGATE token is what gets custodied — never the parent token.
    expect(h.sink.puts).toHaveLength(1);
    expect(h.sink.puts[0]?.token).toBe(DELEGATE_TOKEN);
    expect(h.sink.puts[0]?.actor).toMatch(/install/);

    const rec = await h.registry.lookupByShopDomain(SHOP);
    expect(rec).toBeTruthy();
    expect(rec?.status).toBe("active");
    expect(rec?.shopDomain).toBe(SHOP);
    expect(rec?.region).toBe("us");
    expect(rec?.embedKey).toBeTruthy();
    expect(rec?.tenantId).not.toBe("demo"); // #169 — never the fallback tenant
    expect(h.sink.puts[0]?.tenantId).toBe(rec?.tenantId);
  });

  it("the merchant row and the credential are keyed by the SAME tenant, resolvable by embed key", async () => {
    const h = await harness();
    const { state, cookie } = await begin(h);
    await callback(h, { state, cookie });
    const rec = (await h.registry.lookupByShopDomain(SHOP))!;
    expect(await h.registry.lookupByEmbedKey(rec.embedKey)).toEqual(rec);
    expect(await h.registry.lookupByTenantId(rec.tenantId)).toEqual(rec);
  });

  it("the merchant-facing page tells the truth: recorded, NOT yet serving", async () => {
    const h = await harness();
    const { state, cookie } = await begin(h);
    const res = await callback(h, { state, cookie });
    // #157 discipline — the page may not imply the widget is live, because serving still reads env vars.
    expect(res.body).toMatch(/not (yet )?(live|serving|active)/i);
    expectNoSecrets(res.body, "the success page");
  });

  it("a RE-INSTALL of an uninstalled shop REACTIVATES the same tenant — never a second row for one shop", async () => {
    const h = await harness();
    const first = await begin(h);
    await callback(h, { state: first.state, cookie: first.cookie });
    const rec = (await h.registry.lookupByShopDomain(SHOP))!;
    await h.registry.setStatus(rec.tenantId, "uninstalled", { reason: "test uninstall" });
    expect(await h.registry.lookupByShopDomain(SHOP)).toBeNull(); // inert

    const second = await begin(h);
    expect((await callback(h, { state: second.state, cookie: second.cookie })).statusCode).toBe(200);
    const again = (await h.registry.lookupByShopDomain(SHOP))!;
    expect(again.tenantId).toBe(rec.tenantId);
    expect(again.status).toBe("active");
    expect(again.embedKey).toBe(rec.embedKey); // the storefront snippet keeps working
    expect(again.statusReason).toBeUndefined(); // the stale uninstall reason is cleared
    expect(h.sink.puts).toHaveLength(2); // a fresh delegate credential each time
  });

  it("a repeat install of an ALREADY-ACTIVE shop refreshes the credential without duplicating the row", async () => {
    const h = await harness();
    const a = await begin(h);
    await callback(h, { state: a.state, cookie: a.cookie });
    const rec = (await h.registry.lookupByShopDomain(SHOP))!;
    const b = await begin(h);
    expect((await callback(h, { state: b.state, cookie: b.cookie })).statusCode).toBe(200);
    const after = (await h.registry.lookupByShopDomain(SHOP))!;
    expect(after.tenantId).toBe(rec.tenantId);
    expect(after.createdAt).toBe(rec.createdAt);
    expect(h.sink.puts).toHaveLength(2);
  });

  it("two DIFFERENT shops get two different tenants and two different embed keys", async () => {
    const h = await harness();
    const a = await begin(h, SHOP);
    await callback(h, { state: a.state, cookie: a.cookie, shop: SHOP });
    const b = await begin(h, OTHER_SHOP);
    await callback(h, { state: b.state, cookie: b.cookie, shop: OTHER_SHOP });
    const ra = (await h.registry.lookupByShopDomain(SHOP))!;
    const rb = (await h.registry.lookupByShopDomain(OTHER_SHOP))!;
    expect(ra.tenantId).not.toBe(rb.tenantId);
    expect(ra.embedKey).not.toBe(rb.embedKey);
  });

  it("requests only the delegate scopes this product actually reads (least privilege)", async () => {
    const h = await harness();
    let delegateInput: { delegateAccessScope?: string[]; expiresIn?: number } | undefined;
    h.setFetch((url, init) => {
      if (url.endsWith("/admin/oauth/access_token")) return { ok: true, status: 200, json: async () => ({ access_token: PARENT_TOKEN, scope: GRANTED_SCOPES }) };
      delegateInput = JSON.parse(String(init?.body)).variables?.input;
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { delegateAccessTokenCreate: { delegateAccessToken: { accessToken: DELEGATE_TOKEN, accessScopes: [GRANTED_SCOPES] }, userErrors: [] } } }),
      };
    });
    const { state, cookie } = await begin(h);
    await callback(h, { state, cookie });
    expect(delegateInput?.delegateAccessScope).toEqual([GRANTED_SCOPES]);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("C1 fail-closed on every partial failure", () => {
  it("a failed token exchange leaves NO merchant row, NO credential, and never calls the delegate mutation", async () => {
    const h = await harness();
    h.setFetch((url) => (url.endsWith("/admin/oauth/access_token") ? { ok: false, status: 401, json: async () => ({ error: "invalid_request" }) } : { ok: true, status: 200, json: async () => ({}) }));
    const { state, cookie } = await begin(h);
    const res = await callback(h, { state, cookie });
    expect(res.statusCode).toBe(502);
    expect(h.fetchCalls.filter((u) => u.includes("graphql.json"))).toEqual([]);
    expect(h.sink.puts).toEqual([]);
    expect(await h.registry.lookupByShopDomain(SHOP, { includeInactive: true })).toBeNull();
    expectNoSecrets(res.body, "the failure body");
  });

  it("REFUSES when the merchant granted FEWER scopes than the delegate token needs (the URL-edit attack)", async () => {
    const h = await harness();
    h.setFetch((url) => {
      if (url.endsWith("/admin/oauth/access_token")) return { ok: true, status: 200, json: async () => ({ access_token: PARENT_TOKEN, scope: "read_products" }) };
      return { ok: true, status: 200, json: async () => ({ data: { delegateAccessTokenCreate: { delegateAccessToken: { accessToken: DELEGATE_TOKEN }, userErrors: [] } } }) };
    });
    const { state, cookie } = await begin(h);
    const res = await callback(h, { state, cookie });
    expect(res.statusCode).toBe(502);
    expect(h.fetchCalls.filter((u) => u.includes("graphql.json"))).toEqual([]); // never even attempted
    expect(await h.registry.lookupByShopDomain(SHOP, { includeInactive: true })).toBeNull();
  });

  it("a failed delegate mutation leaves NO merchant row and NO credential", async () => {
    const h = await harness();
    h.setFetch((url) => {
      if (url.endsWith("/admin/oauth/access_token")) return { ok: true, status: 200, json: async () => ({ access_token: PARENT_TOKEN, scope: GRANTED_SCOPES }) };
      return { ok: true, status: 200, json: async () => ({ data: { delegateAccessTokenCreate: { delegateAccessToken: null, userErrors: [{ field: ["input"], message: "scope not granted" }] } } }) };
    });
    const { state, cookie } = await begin(h);
    expect((await callback(h, { state, cookie })).statusCode).toBe(502);
    expect(h.sink.puts).toEqual([]);
    expect(await h.registry.lookupByShopDomain(SHOP, { includeInactive: true })).toBeNull();
  });

  it("a failed CREDENTIAL write never leaves an ACTIVE merchant behind (custody precedes servability)", async () => {
    const h = await harness();
    h.sink.failNext = true;
    const { state, cookie } = await begin(h);
    const res = await callback(h, { state, cookie });
    expect(res.statusCode).toBe(502);
    expect(await h.registry.lookupByShopDomain(SHOP, { includeInactive: true })).toBeNull();
    expectNoSecrets(res.body, "the failure body");
  });

  it("a failed AUDIT write never leaves a merchant registered (an unauditable governed write must not persist)", async () => {
    const store = new InMemoryRuntimeStore();
    const failing: RuntimeStatePort = {
      ...store,
      get: (c, k, v) => store.get(c, k, v),
      put: (c, k, v, val, o) => store.put(c, k, v, val, o),
      delete: (c, k, v) => store.delete(c, k, v),
      list: (c, k) => store.list(c, k),
      audit: async () => {
        throw new Error("audit sink unavailable");
      },
    };
    const h = await harness({}, { store: failing });
    const { state, cookie } = await begin(h);
    const res = await callback(h, { state, cookie });
    expect(res.statusCode).toBe(502);
    expect(await h.registry.lookupByShopDomain(SHOP, { includeInactive: true })).toBeNull();
  });

  it("a registry failure is a 502, not a silent success", async () => {
    const broken = {
      ...createInMemoryMerchantRegistry(),
      create: async () => {
        throw new Error("pl_merchant unique index missing");
      },
    } as unknown as MerchantRegistryPort;
    const h = await harness({}, { registry: broken });
    const { state, cookie } = await begin(h);
    const res = await callback(h, { state, cookie });
    expect(res.statusCode).toBe(502);
    expectNoSecrets(res.body, "the failure body");
    expect(res.body).not.toContain("pl_merchant"); // internal detail stays internal
  });
});

// ---------------------------------------------------------------------------------------------------
describe("C1 audit (NN#5) — every governed registry write is recorded, with a runnable reversal", () => {
  it("audits the `create` under the new tenant, with a reversal path an operator can actually run", async () => {
    const h = await harness();
    const { state, cookie } = await begin(h);
    await callback(h, { state, cookie });
    const rec = (await h.registry.lookupByShopDomain(SHOP))!;

    const log = await auditFor(h.store, rec.tenantId);
    const created = log.find((r) => r.action === "merchant.registered");
    expect(created, "a merchant.registered record must exist").toBeTruthy();
    expect(created?.actor).toMatch(/install/);
    // #179 — the reversal must name something that exists. deploy-staging.yml deploys palup-widget-staging
    // only and the control plane is deployed nowhere, so no HTTP route/console may be named here.
    expect(created?.reversalPath).toBeTruthy();
    expect(created?.reversalPath).toMatch(/uninstalled/);
    expect(created?.reversalPath).not.toMatch(/https?:|POST \/|GET \/|control-plane|Approval Center/);
    expect((await h.store.verifyAudit({ tenantId: rec.tenantId })).ok).toBe(true);
  });

  it("audits the `setStatus` reactivation on a re-install, as its own distinct record", async () => {
    const h = await harness();
    const a = await begin(h);
    await callback(h, { state: a.state, cookie: a.cookie });
    const rec = (await h.registry.lookupByShopDomain(SHOP))!;
    await h.registry.setStatus(rec.tenantId, "uninstalled", { reason: "test" });
    const b = await begin(h);
    await callback(h, { state: b.state, cookie: b.cookie });

    const log = await auditFor(h.store, rec.tenantId);
    const reactivated = log.filter((r) => r.action === "merchant.reactivated");
    expect(reactivated).toHaveLength(1);
    expect(reactivated[0]?.reversalPath).toMatch(/uninstalled/);
    expect(log.filter((r) => r.action === "merchant.registered")).toHaveLength(1); // create happened once
    expect((await h.store.verifyAudit({ tenantId: rec.tenantId })).ok).toBe(true);
  });

  it("NO token, code, HMAC or app secret reaches ANY audit record — asserted on the full JSON", async () => {
    const h = await harness();
    const { state, cookie } = await begin(h);
    await callback(h, { state, cookie });
    const rec = (await h.registry.lookupByShopDomain(SHOP))!;
    const log = await auditFor(h.store, rec.tenantId);
    expect(log.length).toBeGreaterThan(0);
    const json = JSON.stringify(log);
    expectNoSecrets(json, "the audit log");
    expect(json).not.toContain(state); // the CSRF nonce is not audit material either
    expect(json).not.toContain(sign({ code: AUTH_CODE, shop: SHOP, state, timestamp: "1" }));
  });

  it("the audit `input` is an EXACT key allowlist — a later 'just add the token/code' change fails HERE", async () => {
    const h = await harness();
    const { state, cookie } = await begin(h);
    await callback(h, { state, cookie });
    const rec = (await h.registry.lookupByShopDomain(SHOP))!;
    const created = (await auditFor(h.store, rec.tenantId)).find((r) => r.action === "merchant.registered")!;
    expect(Object.keys((created.input ?? {}) as Record<string, unknown>).sort()).toEqual([
      "delegateScopes",
      "region",
      "shopDomain",
      "tenantId",
    ]);
  });

  it("a refused callback appends NOTHING to any audit chain (no attacker-driven audit flood)", async () => {
    const h = await harness();
    const { state, cookie } = await begin(h);
    for (let i = 0; i < 5; i++) await callback(h, { state, cookie, hmac: "deadbeef" });
    // The tenant that WOULD have been created has an empty chain.
    expect(await auditFor(h.store, "acme-store")).toEqual([]);
    expect(await auditFor(h.store, INSTALL_APP_SCOPE)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("C1 no secret leaves the process", () => {
  it("no response body on ANY path contains the app secret, the parent token, the delegate token or the code", async () => {
    const h = await harness();
    const bodies: string[] = [];
    const { state, cookie } = await begin(h);
    bodies.push((await callback(h, { state, cookie, hmac: "bad" })).body);
    bodies.push((await callback(h, { state, cookie, shop: "evil.test" })).body);
    const ok = await begin(h);
    bodies.push((await callback(h, { state: ok.state, cookie: ok.cookie })).body);
    bodies.push((await callback(h, { state: ok.state, cookie: ok.cookie })).body); // replay
    bodies.push((await h.app.inject({ method: "GET", url: `/shopify/install?${qs({ shop: SHOP, timestamp: "1" })}` })).body);
    for (const b of bodies) expectNoSecrets(b, "a response body");
  });

  it("the 302 Location and the state cookie carry no secret material", async () => {
    const h = await harness();
    const res = await h.app.inject({ method: "GET", url: `/shopify/install?${qs({ shop: SHOP, timestamp: String(Math.floor(Date.now() / 1000)) })}` });
    expectNoSecrets(String(res.headers.location), "the authorize URL");
    expectNoSecrets(String(res.headers["set-cookie"]), "the state cookie");
  });

  it("nothing the flow writes to the runtime store contains a token or a code", async () => {
    const h = await harness();
    const { state, cookie } = await begin(h);
    await callback(h, { state, cookie });
    const pending = await h.store.list({ tenantId: INSTALL_APP_SCOPE }, INSTALL_PENDING_COLLECTION);
    expectNoSecrets(JSON.stringify(pending), "the pending-install collection");
    expect(pending).toEqual([]); // consumed
  });
});
