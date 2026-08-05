import { describe, it, expect, afterEach, vi } from "vitest";
import {
  InMemoryRuntimeStore,
  createInMemoryVectorStore,
  createInMemoryMerchantRegistry,
  createEnvSecrets,
} from "@palup/platform-ports";
import type { MerchantRegistryPort, RuntimeStatePort } from "@palup/platform-ports";
import { armKill } from "@palup/state-postgres";
import { buildServer } from "../src/server.js";
import { createMerchantResolver, MERCHANT_RESOLUTION_COLLECTION } from "../src/merchant-resolver.js";
import { resolveShopifyStore, SHOPIFY_TOKEN_SECRET } from "../src/merchant-store.js";

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// D1 — REGISTRY-BACKED KEYS + REVOCATION. The cutover C1 (#189) explicitly did not attempt.
//
// Before this file, `pl_merchant` had rows that NOTHING on the serving path read: `/widget/token`
// resolved a tenant from `WIDGET_EMBED_KEYS` and `/chat` from a widget token, so a merchant who
// completed `app/uninstalled` (#191) had `status = "uninstalled"` written faithfully and STAYED SERVABLE
// FOREVER. These tests pin the two halves of the fix:
//
//   1. RESOLUTION (allowlist, at mint time) — an embed key resolves through the REGISTRY first; the env
//      map is a NAMED, LOGGED, AUDITED fallback that applies only when the registry has no row for that
//      key at all. It NEVER applies when the registry says the merchant is revoked, and it NEVER applies
//      when the registry could not be READ (an unreadable registry is not an absent row — the same
//      distinction `MerchantCredentialRead` draws between `unreadable` and `missing`).
//   2. SERVABILITY (deny-list, per request) — `/chat` re-checks the registry on every turn, so a widget
//      token minted while the merchant was active (TTL up to `WIDGET_TOKEN_TTL_SECONDS`, default 1h) stops
//      working the moment the merchant is revoked. This is the property that did not exist at all.
//
// WHY A DENY-LIST ON `/chat` AND AN ALLOWLIST AT MINT. The set of servable tenants is bounded at mint
// (only a key in the registry or the env map yields a token). Making `/chat` ALSO demand a registry row
// would revoke every env-configured merchant — including the `demo` tenant the eval corpus, the e2e
// suite and the staging smoke gate all run against — the moment this PR landed. So `/chat` asks the
// narrower question that is the whole point: "does the registry say this tenant is NOT servable?"
//
// #169 IS NOT REINTRODUCED. Every fail-closed property that PR won is re-asserted here against the new
// precedence: an unknown key 401s, a malformed registry refuses to boot, and no path resolves an unknown
// key onto the `demo` tenant.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

const ENV_KEYS = [
  "WIDGET_EMBED_KEYS",
  "WIDGET_TOKEN_SECRET",
  "WIDGET_AUTH_REQUIRED",
  "SHOPIFY_STORES",
  "SHOPPER_AUTH",
  "SHOPPER_TOKEN_SECRET",
  "PALUP_SECRETS",
  "PALUP_REQUIRE_DATABASE_URL",
  "CAA_REDIRECT_URI",
];
afterEach(() => {
  ENV_KEYS.forEach((k) => delete process.env[k]);
  vi.restoreAllMocks();
});

const SHOP = "acme-store.myshopify.com";
const TENANT = "acme-store";
const KEY = "pk_acme_live";
const VALID_ANON_ID = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

async function activeRegistry(): Promise<MerchantRegistryPort> {
  const registry = createInMemoryMerchantRegistry();
  await registry.create({ tenantId: TENANT, shopDomain: SHOP, embedKey: KEY, region: "us" });
  return registry;
}

async function serve(registry?: MerchantRegistryPort): Promise<{ app: Awaited<ReturnType<typeof buildServer>>; store: RuntimeStatePort }> {
  process.env.WIDGET_TOKEN_SECRET ??= "widget-signing-secret";
  const store = new InMemoryRuntimeStore();
  const app = await buildServer({
    store,
    vectorPort: createInMemoryVectorStore(),
    ...(registry ? { merchantRegistry: registry } : {}),
  });
  return { app, store };
}

async function mint(app: Awaited<ReturnType<typeof buildServer>>, key: string): Promise<{ status: number; token?: string }> {
  const res = await app.inject({ method: "GET", url: `/widget/token?key=${encodeURIComponent(key)}` });
  return { status: res.statusCode, token: res.statusCode === 200 ? (res.json() as { token: string }).token : undefined };
}

function chat(app: Awaited<ReturnType<typeof buildServer>>, token: string | undefined, sessionId: string) {
  return app.inject({
    method: "POST",
    url: "/chat",
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    payload: { sessionId, message: "do you have a moisturizer for dry skin?", signals: {} },
  });
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe("D1 (1) the registry is now the FIRST source for an embed key", () => {
  it("mints for a registry-only merchant that appears in NO env var, and binds the REGISTRY tenant", async () => {
    const registry = await activeRegistry();
    const { app, store } = await serve(registry);
    // Nothing in WIDGET_EMBED_KEYS names this merchant — before D1 this key 401'd.
    const m = await mint(app, KEY);
    expect(m.status).toBe(200);
    expect(m.token).toBeTruthy();

    // Prove the token really carries the REGISTRY tenant id (not `demo`): a kill armed for that exact
    // tenant scope must halt this token's turn. NN#4 stays the independent authority it always was.
    await armKill(store, `tenant:${TENANT}`, "d1-tenant-binding-probe");
    const res = await chat(app, m.token, "bind-1");
    expect((res.json() as { flags: string[] }).flags).toContain("kill_switch");
    await app.close();
  });

  it("a registry row WINS over an env entry that maps the same key elsewhere", async () => {
    process.env.WIDGET_EMBED_KEYS = JSON.stringify({ [KEY]: "some-other-tenant" });
    const registry = await activeRegistry();
    const { app, store } = await serve(registry);
    const m = await mint(app, KEY);
    expect(m.status).toBe(200);
    await armKill(store, `tenant:${TENANT}`, "registry-wins");
    expect(((await chat(app, m.token, "win-1")).json() as { flags: string[] }).flags).toContain("kill_switch");
    await app.close();
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe("D1 (2) THE HEADLINE — revocation now revokes, end to end, through /chat", () => {
  it("a live widget token stops working the moment the merchant is set uninstalled", async () => {
    const registry = await activeRegistry();
    const { app } = await serve(registry);
    const m = await mint(app, KEY);
    expect(m.status).toBe(200);

    // Served while active.
    const before = await chat(app, m.token, "rev-1");
    expect(before.statusCode).toBe(200);
    expect((before.json() as { flags: string[] }).flags ?? []).not.toContain("merchant_inactive");

    // Exactly what C2's `app/uninstalled` handler does (routes/shopify-webhooks.ts).
    await registry.setStatus(TENANT, "uninstalled", { reason: "app/uninstalled webhook" });

    // THE SAME, STILL CRYPTOGRAPHICALLY VALID TOKEN is now refused.
    const after = await chat(app, m.token, "rev-2");
    expect(after.statusCode).toBe(403);
    expect((after.json() as { flags: string[] }).flags).toContain("merchant_inactive");

    // ...and the embed key no longer mints a new one.
    expect((await mint(app, KEY)).status).toBe(401);
    await app.close();
  });

  it("`suspended` (billing hold) is refused the same way — `active` is the ONLY servable state", async () => {
    const registry = await activeRegistry();
    const { app } = await serve(registry);
    const m = await mint(app, KEY);
    await registry.setStatus(TENANT, "suspended", { reason: "billing hold" });
    expect((await chat(app, m.token, "susp-1")).statusCode).toBe(403);
    expect((await mint(app, KEY)).status).toBe(401);
    await app.close();
  });

  it("reactivation restores servability (the reversal path the audit names is real)", async () => {
    const registry = await activeRegistry();
    const { app } = await serve(registry);
    await registry.setStatus(TENANT, "uninstalled", { reason: "app/uninstalled webhook" });
    expect((await mint(app, KEY)).status).toBe(401);
    await registry.setStatus(TENANT, "active", { reason: "re-install" });
    const m = await mint(app, KEY);
    expect(m.status).toBe(200);
    expect((await chat(app, m.token, "react-1")).statusCode).toBe(200);
    await app.close();
  });

  it("a STALE env entry cannot resurrect a revoked merchant (revocation outranks the fallback)", async () => {
    // The realistic operator mistake: the merchant uninstalls, the webhook revokes them, and nobody
    // remembers to strip their key out of WIDGET_EMBED_KEYS.
    process.env.WIDGET_EMBED_KEYS = JSON.stringify({ [KEY]: TENANT, "demo-embed-key": "demo" });
    const registry = await activeRegistry();
    const { app } = await serve(registry);
    await registry.setStatus(TENANT, "uninstalled", { reason: "app/uninstalled webhook" });
    expect((await mint(app, KEY)).status).toBe(401);
    // The other, un-revoked env tenant is unaffected — a revocation is per merchant, not a global halt.
    expect((await mint(app, "demo-embed-key")).status).toBe(200);
    await app.close();
  });

  it("a refusal is AUDITED once per tenant per window, with a runnable reversal path (NN#5)", async () => {
    const registry = await activeRegistry();
    const { app, store } = await serve(registry);
    const m = await mint(app, KEY);
    await registry.setStatus(TENANT, "uninstalled", { reason: "app/uninstalled webhook" });

    await chat(app, m.token, "aud-1");
    await chat(app, m.token, "aud-2"); // a second refusal must NOT append a second row
    const audit = await store.readAudit({ tenantId: TENANT });
    const refusals = audit.filter((a) => a.action === "merchant.serving_refused");
    expect(refusals).toHaveLength(1);
    expect(refusals[0].reversalPath).toContain("jobs/merchant.ts");
    expect(refusals[0].reversalPath).toContain("--status active");
    expect(JSON.stringify(refusals[0])).toContain("uninstalled");
    // Dedup is a bounded, TTL'd marker — never an unbounded append primitive on an attacker-reachable route.
    expect(await store.get({ tenantId: TENANT }, MERCHANT_RESOLUTION_COLLECTION, "refused:chat")).not.toBeNull();
    await app.close();
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe("D1 (3) precedence + fallback are EXPLICIT and OBSERVABLE (never silent — #169's lesson)", () => {
  it("the env fallback applies only when the registry has NO row, and says so in a log line", async () => {
    process.env.WIDGET_EMBED_KEYS = JSON.stringify({ "demo-embed-key": "demo" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registry = createInMemoryMerchantRegistry(); // durable-shaped, but empty: no `demo` row
    const { app } = await serve(registry);
    expect((await mint(app, "demo-embed-key")).status).toBe(200);
    const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toMatch(/\[merchant\]/);
    expect(logged).toMatch(/demo/);
    expect(logged).toMatch(/WIDGET_EMBED_KEYS/);
    await app.close();
  });

  it("the env fallback is AUDITED at mint time — the resolution decision that matters (NN#5)", async () => {
    process.env.WIDGET_EMBED_KEYS = JSON.stringify({ "demo-embed-key": "demo" });
    const { app, store } = await serve(createInMemoryMerchantRegistry());
    await mint(app, "demo-embed-key");
    await mint(app, "demo-embed-key"); // deduped
    const actions = (await store.readAudit({ tenantId: "demo" })).map((a) => a.action);
    expect(actions.filter((a) => a === "merchant.resolved_from_env")).toHaveLength(1);
    await app.close();
  });

  it("does NOT audit the env fallback when no registry is wired — that is noise, not a governance fact", async () => {
    // With no registry, env is not a "fallback", it is the only mechanism there is: recording it on the
    // first turn of every dev/e2e process says nothing `/health` does not already say. The LOG LINE and the
    // /health mode still fire, so requirement 3 ("never silent") holds in both postures. This also keeps
    // widget-tenant.test.ts's exact per-tenant audit counts (:38, :75) meaningful.
    const { app, store } = await serve(); // no registry
    await mint(app, "demo-embed-key");
    expect((await store.readAudit({ tenantId: "demo" })).map((a) => a.action)).not.toContain("merchant.resolved_from_env");
    await app.close();
  });

  it("/health names the resolution mode, so an operator can see the fallback is armed", async () => {
    const { app } = await serve(await activeRegistry());
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toMatchObject({ merchants: "registry+env" });
    await app.close();
  });

  it("/health reports env-only resolution when no durable registry is wired (local/dev/e2e)", async () => {
    const { app } = await serve();
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toMatchObject({ merchants: "env" });
    await app.close();
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe("D1 (4) FAIL CLOSED — no path resolves an unknown or unreadable key to a working tenant (#169)", () => {
  it("an unknown key 401s even though the registry AND the env map both hold other merchants", async () => {
    process.env.WIDGET_EMBED_KEYS = JSON.stringify({ "demo-embed-key": "demo" });
    const { app } = await serve(await activeRegistry());
    expect((await mint(app, "pk_never_registered")).status).toBe(401);
    await app.close();
  });

  it("a blank / non-string key 401s and never reaches the registry (a blank id is a cross-tenant wildcard)", async () => {
    const registry = await activeRegistry();
    const spy = vi.spyOn(registry, "lookupByEmbedKey");
    const { app } = await serve(registry);
    expect((await app.inject({ method: "GET", url: "/widget/token?key=" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/widget/token" })).statusCode).toBe(401);
    expect(spy).not.toHaveBeenCalled();
    await app.close();
  });

  it("a registry READ FAILURE refuses the mint — an unreadable registry is NOT an absent row", async () => {
    process.env.WIDGET_EMBED_KEYS = JSON.stringify({ [KEY]: TENANT });
    const registry = await activeRegistry();
    vi.spyOn(registry, "lookupByEmbedKey").mockRejectedValue(new Error("connection terminated unexpectedly"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app } = await serve(registry);
    const res = await app.inject({ method: "GET", url: `/widget/token?key=${KEY}` });
    expect(res.statusCode).toBe(401); // NOT a silent fall-through to the env map
    // The failure is observable, and it never echoes the driver's message (it can carry config).
    expect(err.mock.calls.map((c) => c.join(" ")).join("\n")).toMatch(/\[merchant\]/);
    expect(res.body).not.toContain("connection terminated");
    await app.close();
  });

  it("a registry READ FAILURE on the /chat servability check refuses the turn, not serves it", async () => {
    const registry = await activeRegistry();
    const { app } = await serve(registry);
    const m = await mint(app, KEY);
    vi.spyOn(registry, "lookupByTenantId").mockRejectedValue(new Error("connection terminated unexpectedly"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await chat(app, m.token, "err-1");
    expect(res.statusCode).toBe(403);
    expect((res.json() as { flags: string[] }).flags).toContain("merchant_unresolved");
    await app.close();
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe("D1 (5) the `demo` tenant decision: env stays an EXPLICIT, NAMED fallback", () => {
  it("local/dev/e2e is byte-identical — nothing configured ⇒ demo-embed-key still mints tenant demo", async () => {
    const { app } = await serve(); // no registry at all (no DATABASE_URL) — the e2e/eval posture
    const m = await mint(app, "demo-embed-key");
    expect(m.status).toBe(200);
    expect((await chat(app, m.token, "demo-1")).statusCode).toBe(200);
    await app.close();
  });

  it("with a durable registry wired but NO demo row, staging's demo key still mints (the smoke gate)", async () => {
    process.env.WIDGET_EMBED_KEYS = JSON.stringify({ "demo-embed-key": "demo" });
    const { app } = await serve(createInMemoryMerchantRegistry());
    const m = await mint(app, "demo-embed-key");
    expect(m.status).toBe(200);
    expect((await chat(app, m.token, "demo-2")).statusCode).toBe(200);
    await app.close();
  });

  it("an unauthenticated /chat still falls back to the demo tenant during the rollout window", async () => {
    // WIDGET_AUTH_REQUIRED off ⇒ RUNTIME_TENANT. A registry with no `demo` row must not break it.
    const { app } = await serve(createInMemoryMerchantRegistry());
    expect((await chat(app, undefined, "demo-3")).statusCode).toBe(200);
    await app.close();
  });

  it("...but once `demo` IS registered and revoked, even that fallback is refused", async () => {
    const registry = createInMemoryMerchantRegistry();
    await registry.create({ tenantId: "demo", shopDomain: "demo-store.myshopify.com", embedKey: "demo-embed-key", region: "us" });
    await registry.setStatus("demo", "uninstalled", { reason: "app/uninstalled webhook" });
    const { app } = await serve(registry);
    expect((await chat(app, undefined, "demo-4")).statusCode).toBe(403);
    await app.close();
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe("D1 (6) DATA-RIGHTS paths are deliberately NOT gated on servability", () => {
  it("POST /forget still works for an uninstalled merchant (erasure must outlive the install)", async () => {
    const registry = await activeRegistry();
    const { app } = await serve(registry);
    const m = await mint(app, KEY);
    await registry.setStatus(TENANT, "uninstalled", { reason: "app/uninstalled webhook" });
    const res = await app.inject({
      method: "POST",
      url: "/forget",
      headers: { authorization: `Bearer ${m.token}` },
      payload: { anonId: VALID_ANON_ID },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    await app.close();
  });

  it("POST /consent still works for an uninstalled merchant (withdrawal is a data-subject right)", async () => {
    const registry = await activeRegistry();
    const { app } = await serve(registry);
    const m = await mint(app, KEY);
    await registry.setStatus(TENANT, "uninstalled", { reason: "app/uninstalled webhook" });
    const res = await app.inject({
      method: "POST",
      url: "/consent",
      headers: { authorization: `Bearer ${m.token}` },
      payload: { anonId: VALID_ANON_ID, memoryOrdinary: "out", memorySpecial: "out" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe("D1 (7) no new audit noise on the normal serving path", () => {
  it("a benign /chat turn for an ACTIVE registry merchant appends NOTHING to the audit chain", async () => {
    const registry = await activeRegistry();
    const { app, store } = await serve(registry);
    const m = await mint(app, KEY);
    await chat(app, m.token, "quiet-1");
    expect(await store.readAudit({ tenantId: TENANT })).toHaveLength(0);
    await app.close();
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe("D1 (8) the resolver itself — the ONE place the precedence rule lives", () => {
  const envMap = (o: Record<string, string>): Record<string, string> => Object.assign(Object.create(null), o);

  it("resolveEmbedKey: registry active → registry; no row → env; revoked → refused; unknown → unknown", async () => {
    const registry = await activeRegistry();
    const r = createMerchantResolver({
      store: new InMemoryRuntimeStore(),
      registry,
      embedKeys: envMap({ "demo-embed-key": "demo" }),
      storeDomains: () => envMap({}),
    });
    expect(await r.resolveEmbedKey(KEY, "embed-key-mint")).toMatchObject({ kind: "ok", tenantId: TENANT, source: "registry" });
    expect(await r.resolveEmbedKey("demo-embed-key", "embed-key-mint")).toMatchObject({ kind: "ok", tenantId: "demo", source: "env" });
    expect(await r.resolveEmbedKey("pk_nope", "embed-key-mint")).toMatchObject({ kind: "unknown" });
    await registry.setStatus(TENANT, "uninstalled");
    expect(await r.resolveEmbedKey(KEY, "embed-key-mint")).toMatchObject({ kind: "revoked", tenantId: TENANT, status: "uninstalled" });
  });

  it("servability is a REVOCATION check, not an allowlist: an unregistered tenant stays servable", async () => {
    const registry = await activeRegistry();
    const r = createMerchantResolver({
      store: new InMemoryRuntimeStore(),
      registry,
      embedKeys: envMap({}),
      storeDomains: () => envMap({}),
    });
    expect(await r.servability("demo", "chat")).toMatchObject({ kind: "servable", source: "env" });
    expect(await r.servability(TENANT, "chat")).toMatchObject({ kind: "servable", source: "registry" });
    await registry.setStatus(TENANT, "suspended");
    expect(await r.servability(TENANT, "chat")).toMatchObject({ kind: "revoked", status: "suspended" });
  });

  it("with no registry at all, everything resolves from env exactly as before D1", async () => {
    const r = createMerchantResolver({
      store: new InMemoryRuntimeStore(),
      embedKeys: envMap({ "demo-embed-key": "demo" }),
      storeDomains: () => envMap({ demo: "palup-skincare-jason.myshopify.com" }),
    });
    expect(r.resolutionMode).toBe("env");
    expect(await r.resolveEmbedKey("demo-embed-key", "embed-key-mint")).toMatchObject({ kind: "ok", tenantId: "demo", source: "env" });
    expect(await r.shopDomainFor("demo")).toBe("palup-skincare-jason.myshopify.com");
    expect(await r.servability("demo", "chat")).toMatchObject({ kind: "servable", source: "env" });
  });

  it("shopDomainFor / tenantForShopDomain: registry wins, env fills the gap, revoked resolves to NOTHING", async () => {
    const registry = await activeRegistry();
    const r = createMerchantResolver({
      store: new InMemoryRuntimeStore(),
      registry,
      embedKeys: envMap({}),
      storeDomains: () => envMap({ demo: "palup-skincare-jason.myshopify.com", [TENANT]: "stale-env-host.myshopify.com" }),
    });
    expect(await r.shopDomainFor(TENANT)).toBe(SHOP); // the registry row, not the stale env value
    expect(await r.shopDomainFor("demo")).toBe("palup-skincare-jason.myshopify.com"); // env fallback
    expect(await r.tenantForShopDomain(SHOP)).toMatchObject({ kind: "ok", tenantId: TENANT, source: "registry" });
    expect(await r.tenantForShopDomain("palup-skincare-jason.myshopify.com")).toMatchObject({ kind: "ok", tenantId: "demo", source: "env" });
    expect(await r.tenantForShopDomain("ACME-STORE.MYSHOPIFY.COM")).toMatchObject({ kind: "ok", tenantId: TENANT }); // hosts are case-insensitive

    await registry.setStatus(TENANT, "uninstalled");
    expect(await r.shopDomainFor(TENANT)).toBeUndefined(); // NOT the stale env host
    expect(await r.tenantForShopDomain(SHOP)).toMatchObject({ kind: "revoked", status: "uninstalled" });
  });

  it("a registry throw is reported as `error`, never as absent", async () => {
    const registry = await activeRegistry();
    vi.spyOn(registry, "lookupByEmbedKey").mockRejectedValue(new Error("boom"));
    vi.spyOn(registry, "lookupByTenantId").mockRejectedValue(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = createMerchantResolver({
      store: new InMemoryRuntimeStore(),
      registry,
      embedKeys: envMap({ "demo-embed-key": "demo" }),
      storeDomains: () => envMap({ demo: "x.myshopify.com" }),
    });
    expect(await r.resolveEmbedKey("demo-embed-key", "embed-key-mint")).toMatchObject({ kind: "error" });
    expect(await r.servability("demo", "chat")).toMatchObject({ kind: "error" });
    expect(await r.shopDomainFor("demo")).toBeUndefined();
  });

  it("an audit failure can NEVER make a revoked merchant servable (a denial is not a governed write)", async () => {
    const registry = await activeRegistry();
    await registry.setStatus(TENANT, "uninstalled");
    const store = new InMemoryRuntimeStore();
    vi.spyOn(store, "audit").mockRejectedValue(new Error("audit chain unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = createMerchantResolver({ store, registry, embedKeys: envMap({}), storeDomains: () => envMap({}) });
    expect(await r.servability(TENANT, "chat")).toMatchObject({ kind: "revoked", status: "uninstalled" });
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe("D1 (8b) an installed merchant's embed key is REACHABLE — otherwise the cutover is unusable", () => {
  it("the operator CLI prints the embedKey, the one value a storefront snippet needs", async () => {
    // Before D1 this line omitted `embedKey`, and grepping widget-backend/src + control-plane/src showed
    // NOTHING else surfaced it either: the install generates the key, writes it to pl_merchant, and no
    // route, page or console ever returns it. D1 makes that key the thing that mints a widget token, so a
    // merchant who installed would hold a live registry row they could not use. This is the delivery path.
    const { describeMerchantForOperator } = await import("../src/jobs/merchant.js");
    const line = describeMerchantForOperator({
      tenantId: TENANT,
      shopDomain: SHOP,
      embedKey: KEY,
      status: "active",
      region: "us",
      groundingMode: "full",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(line).toContain(`embedKey=${KEY}`);
    expect(line).toContain(`shop=${SHOP}`);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe("D1 (9) grounding resolves its shop domain through the SAME resolver", () => {
  it("resolveShopifyStore takes the registry's domain, and refuses a revoked merchant outright", async () => {
    process.env.PALUP_SECRETS = JSON.stringify({ [TENANT]: { [SHOPIFY_TOKEN_SECRET]: "storefront-token-never-logged" } });
    const registry = await activeRegistry();
    const r = createMerchantResolver({
      store: new InMemoryRuntimeStore(),
      registry,
      embedKeys: Object.create(null),
      storeDomains: () => Object.assign(Object.create(null), { [TENANT]: "stale-env-host.myshopify.com" }),
    });
    const secrets = createEnvSecrets();
    const creds = await resolveShopifyStore(TENANT, secrets, undefined, { shopDomainFor: (t) => r.shopDomainFor(t) });
    expect(creds?.shopDomain).toBe(SHOP);

    await registry.setStatus(TENANT, "uninstalled");
    expect(await resolveShopifyStore(TENANT, secrets, undefined, { shopDomainFor: (t) => r.shopDomainFor(t) })).toBeUndefined();
  });

  it("without the resolver seam, resolveShopifyStore is byte-identical to before (the catalog job's path)", async () => {
    process.env.PALUP_SECRETS = JSON.stringify({ demo: { [SHOPIFY_TOKEN_SECRET]: "tok" } });
    const domains = Object.assign(Object.create(null), { demo: "palup-skincare-jason.myshopify.com" });
    const creds = await resolveShopifyStore("demo", createEnvSecrets(), domains);
    expect(creds).toEqual({ shopDomain: "palup-skincare-jason.myshopify.com", accessToken: "tok" });
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe("D1 (10) the OTHER tenant-resolving routes honour revocation too", () => {
  it("/shopper/session 404s for a revoked merchant (no shopper session is minted on a dead store)", async () => {
    process.env.WIDGET_AUTH_REQUIRED = "true";
    process.env.SHOPPER_AUTH = "true";
    process.env.SHOPPER_TOKEN_SECRET = "shopper-signing-secret";
    const registry = await activeRegistry();
    const { app } = await serve(registry);
    const m = await mint(app, KEY);
    expect(m.status).toBe(200);
    // Active: reachable (the App-Proxy signature is absent, so it answers "browsing", not 404).
    const live = await app.inject({ method: "GET", url: "/shopper/session", headers: { authorization: `Bearer ${m.token}` } });
    expect(live.statusCode).toBe(200);

    await registry.setStatus(TENANT, "uninstalled", { reason: "app/uninstalled webhook" });
    const dead = await app.inject({ method: "GET", url: "/shopper/session", headers: { authorization: `Bearer ${m.token}` } });
    expect(dead.statusCode).toBe(404);
    await app.close();
  });

  it("/auth/customer/login 401s a revoked merchant's embed key rather than starting an OAuth flow", async () => {
    process.env.WIDGET_AUTH_REQUIRED = "true";
    process.env.SHOPPER_AUTH = "true";
    process.env.SHOPPER_TOKEN_SECRET = "shopper-signing-secret";
    process.env.CAA_REDIRECT_URI = "https://widget.palup.ai/auth/customer/callback";
    const registry = await activeRegistry();
    const { app } = await serve(registry);
    await registry.setStatus(TENANT, "uninstalled", { reason: "app/uninstalled webhook" });
    const res = await app.inject({ method: "GET", url: `/auth/customer/login?key=${KEY}` });
    expect(res.statusCode).toBe(401);
    delete process.env.CAA_REDIRECT_URI;
    await app.close();
  });
});
