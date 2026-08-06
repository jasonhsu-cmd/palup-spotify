import { describe, it, expect, afterEach, vi } from "vitest";
import {
  InMemoryRuntimeStore,
  createInMemoryVectorStore,
  createInMemoryMerchantRegistry,
} from "@palup/platform-ports";
import type {
  MerchantRecord,
  MerchantRegion,
  MerchantRegistryPort,
  ModelPort,
  ModelRequest,
  RuntimeStatePort,
} from "@palup/platform-ports";
import { buildServer } from "../src/server.js";
import { createMerchantResolver, consentModeFor } from "../src/merchant-resolver.js";
import { guestTokenHeader } from "./helpers/guest-token.js";

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// D2 — PER-TENANT REGION. The residency gap D1 named and deliberately left open
// (merchant-resolver.ts's "WHAT IT STILL DOES NOT DO", bullet 1).
//
// WHY THIS IS A LEGAL DEFECT AND NOT A CONFIG ONE. `region` decides the CONSENT REGIME:
// `consentPermits(region, "ordinary", value)` is `region === "us" ? value !== "out" : value === "in"`
// (widget-brain/src/consent-rules.ts). So serving an EU merchant under a `"us"` region does not merely
// mislabel anything — it converts an OPT-IN regime into an OPT-OUT one and writes cross-visit facts
// about EU shoppers who never consented. Before D2 that was guaranteed on any instance whose
// process-wide `MERCHANT_REGION` disagreed with the merchant's recorded residency, and one process
// serves every merchant.
//
// THE RULE D2 ADDS, in the same shape D1 established for identity:
//   1. the registry has an ACTIVE row with a VALID region  ⇒ that region + that groundingMode. Registry wins.
//   2. the registry has NO row for this tenant             ⇒ `MERCHANT_REGION`/`MERCHANT_GROUNDING_MODE`,
//                                                            the named env fallback (this is `demo`).
//   3. the row is active but its region is MISSING/INVALID ⇒ REFUSE. Never the env default.
//   4. the registry is UNREADABLE                          ⇒ REFUSE (D1's rule, unchanged).
//
// WHY (3) REFUSES RATHER THAN FALLING BACK. The env fallback is legitimate for IDENTITY because the
// absence of a row is an unambiguous fact ("nobody claims this key"). An active row with no usable region
// is not an absence — it is a merchant we HAVE and whose jurisdiction we do not know, and the fallback
// value would be a residency decision made by an unset env var, which is precisely what the legal review
// flagged and why `NewMerchant.region` is required with no default (merchant-registry-port.ts). Guessing
// `"us"` there is the failure mode; refusing is loud, per-merchant, and reversible in one command.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

const ENV_KEYS = [
  "MERCHANT_REGION",
  "MERCHANT_GROUNDING_MODE",
  "WIDGET_EMBED_KEYS",
  "WIDGET_TOKEN_SECRET",
  "WIDGET_AUTH_REQUIRED",
  "SHOPIFY_STORES",
  "PALUP_SECRETS",
  "GUEST_TOKEN_SECRET",
];
// ADR-0019 task 4/9 — the guest memory subject now comes ONLY from a VERIFIED `x-guest-token`, never
// `body.anonId` / `signals.anonId` (invariant 4).
const GUEST_SECRET = "gsecret";
afterEach(() => {
  ENV_KEYS.forEach((k) => delete process.env[k]);
  vi.restoreAllMocks();
});

const US_TENANT = "us-store";
const US_KEY = "pk_us_live";
const EU_TENANT = "eu-store";
const EU_KEY = "pk_eu_live";
const GUEST_ANON_ID = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // base32, passes validateAnonId

async function twoRegionRegistry(): Promise<MerchantRegistryPort> {
  const registry = createInMemoryMerchantRegistry();
  await registry.create({ tenantId: US_TENANT, shopDomain: "us-store.myshopify.com", embedKey: US_KEY, region: "us" });
  await registry.create({ tenantId: EU_TENANT, shopDomain: "eu-store.myshopify.com", embedKey: EU_KEY, region: "eu" });
  return registry;
}

/**
 * A registry whose row for `tenantId` comes back with a region the enum does not contain. This is not a
 * hypothetical: `PostgresMerchantRegistry.toRecord` casts (`row.region as MerchantRegion`,
 * postgres-merchant-registry.ts) and its CHECK constraint only rides along with `CREATE TABLE`, which its
 * own `migrate()` doc comment says a pre-existing table would not retroactively gain. A hand-inserted or
 * migrated row is the reachable path.
 */
function withBadRegion(inner: MerchantRegistryPort, tenantId: string, region: unknown): MerchantRegistryPort {
  const patch = (rec: MerchantRecord | null): MerchantRecord | null =>
    rec && rec.tenantId === tenantId ? { ...rec, region: region as MerchantRegion } : rec;
  return {
    create: (i) => inner.create(i),
    setStatus: (t, s, o) => inner.setStatus(t, s, o),
    update: (t, p) => inner.update(t, p),
    lookupByTenantId: async (t, o) => patch(await inner.lookupByTenantId(t, o)),
    lookupByShopDomain: async (d, o) => patch(await inner.lookupByShopDomain(d, o)),
    lookupByEmbedKey: async (k, o) => patch(await inner.lookupByEmbedKey(k, o)),
  };
}

async function serve(
  registry?: MerchantRegistryPort,
  extra: Parameters<typeof buildServer>[0] = {},
): Promise<{ app: Awaited<ReturnType<typeof buildServer>>; store: RuntimeStatePort }> {
  process.env.WIDGET_TOKEN_SECRET ??= "widget-signing-secret";
  const store = new InMemoryRuntimeStore();
  const app = await buildServer({
    store,
    vectorPort: createInMemoryVectorStore(),
    ...(registry ? { merchantRegistry: registry } : {}),
    ...extra,
  });
  return { app, store };
}

async function mint(app: Awaited<ReturnType<typeof buildServer>>, key: string): Promise<{ status: number; token?: string }> {
  const res = await app.inject({ method: "GET", url: `/widget/token?key=${encodeURIComponent(key)}` });
  return { status: res.statusCode, token: res.statusCode === 200 ? (res.json() as { token: string }).token : undefined };
}

function chat(
  app: Awaited<ReturnType<typeof buildServer>>,
  token: string | undefined,
  sessionId: string,
  signals: Record<string, unknown> = {},
) {
  return app.inject({
    method: "POST",
    url: "/chat",
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    payload: { sessionId, message: "do you have a moisturizer for dry skin?", signals },
  });
}

/** A model that always returns one distillable ordinary fact, so a memory WRITE either happens or does
 *  not — which is the only honest way to test a consent regime (mirrors manage-panel-honesty.test.ts). */
function distillingModel(): ModelPort & { calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  return {
    calls,
    async complete(req: ModelRequest) {
      calls.push(req);
      return { text: JSON.stringify({ facts: [{ text: "prefers fragrance-free products" }] }), model: "spy-distiller" };
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe("D2 (1) THE HEADLINE — a merchant is served their OWN jurisdiction, not the process's", () => {
  it("an EU merchant on a US-defaulted process gets the OPT-IN regime", async () => {
    // MERCHANT_REGION unset ⇒ the process default is "us" (server.ts). Before D2 this EU merchant's
    // shoppers were served under the US opt-out regime.
    const { app } = await serve(await twoRegionRegistry());
    const m = await mint(app, EU_KEY);
    expect(m.status).toBe(200);
    const res = await chat(app, m.token, "eu-1");
    expect(res.statusCode).toBe(200);
    expect(res.json().consentMode).toBe("opt_in");
    await app.close();
  });

  it("...and the US merchant on that SAME instance still gets opt-out, in the same process", async () => {
    // The multi-tenant property: one Cloud Run instance, two jurisdictions, simultaneously. This is the
    // thing a process-wide env var cannot express at all.
    const { app } = await serve(await twoRegionRegistry());
    const eu = await mint(app, EU_KEY);
    const us = await mint(app, US_KEY);
    expect((await chat(app, eu.token, "mix-eu")).json().consentMode).toBe("opt_in");
    expect((await chat(app, us.token, "mix-us")).json().consentMode).toBe("opt_out");
    await app.close();
  });

  it("the process env cannot override a merchant's recorded residency in EITHER direction", async () => {
    process.env.MERCHANT_REGION = "eu"; // an EU-defaulted process...
    const { app } = await serve(await twoRegionRegistry());
    const us = await mint(app, US_KEY);
    expect((await chat(app, us.token, "override-1")).json().consentMode).toBe("opt_out"); // ...serving a US row
    await app.close();
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe("D2 (2) it is the WRITE GATE that moves, not just the reported label", () => {
  it("EU merchant + never-answered consent: NOTHING is written (the US opt-out default no longer applies)", async () => {
    // The defect, made observable: with `MERCHANT_REGION` at its "us" default, `decideMemoryWrite` read
    // "unknown" as ALLOWED and a fact about an EU shopper was persisted. `consentPermits` for a non-US
    // region requires an explicit "in".
    process.env.WIDGET_AUTH_REQUIRED = "true"; // the memory boot guard (assertMemoryAuthCoupling)
    process.env.GUEST_TOKEN_SECRET = GUEST_SECRET;
    const vector = createInMemoryVectorStore();
    const upsert = vi.spyOn(vector, "upsert");
    const { app } = await serve(await twoRegionRegistry(), {
      vectorPort: vector,
      modelPort: distillingModel(),
      memoryEnabled: true,
    });
    const m = await mint(app, EU_KEY);
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      headers: { authorization: `Bearer ${m.token}`, ...guestTokenHeader(GUEST_SECRET, EU_TENANT, GUEST_ANON_ID) },
      payload: { sessionId: "eu-write", message: "do you have a moisturizer for dry skin?", signals: {} },
    });
    expect(res.statusCode).toBe(200);
    // The report and reality are pinned together, so neither can drift into lying alone.
    expect(res.json().memoryActive).toEqual({ ordinary: false, special: false });
    expect(upsert).not.toHaveBeenCalled();
    await app.close();
  });

  it("US merchant, same instance, same turn shape: the opt-out regime still writes", async () => {
    process.env.WIDGET_AUTH_REQUIRED = "true";
    process.env.GUEST_TOKEN_SECRET = GUEST_SECRET;
    const vector = createInMemoryVectorStore();
    const upsert = vi.spyOn(vector, "upsert");
    const { app } = await serve(await twoRegionRegistry(), {
      vectorPort: vector,
      modelPort: distillingModel(),
      memoryEnabled: true,
    });
    const m = await mint(app, US_KEY);
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      headers: { authorization: `Bearer ${m.token}`, ...guestTokenHeader(GUEST_SECRET, US_TENANT, GUEST_ANON_ID) },
      payload: { sessionId: "us-write", message: "do you have a moisturizer for dry skin?", signals: {} },
    });
    expect(res.json().memoryActive).toEqual({ ordinary: true, special: false });
    expect(upsert).toHaveBeenCalled();
    await app.close();
  });

  it("POST /consent answers with the MERCHANT's regime too (the manage panel must not disagree with /chat)", async () => {
    process.env.MERCHANT_REGION = "us"; // the process says opt-out...
    process.env.GUEST_TOKEN_SECRET = GUEST_SECRET;
    const registry = await twoRegionRegistry();
    const { app } = await serve(registry);
    const eu = await mint(app, EU_KEY);
    const res = await app.inject({
      method: "POST",
      url: "/consent",
      headers: { authorization: `Bearer ${eu.token}`, ...guestTokenHeader(GUEST_SECRET, EU_TENANT, GUEST_ANON_ID) },
      payload: { memoryOrdinary: "unknown", memorySpecial: "unknown" },
    });
    expect(res.statusCode).toBe(200);
    // ...but "unknown" is NOT a grant in the EU, and this endpoint is what the panel renders.
    expect(res.json().memoryActive).toEqual({ ordinary: false, special: false });
    await app.close();
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe("D2 (3) FAIL CLOSED — an active row with no usable region is REFUSED, never defaulted", () => {
  it("/chat refuses with a DISTINGUISHABLE flag rather than serving the merchant as `us`", async () => {
    process.env.MERCHANT_REGION = "us"; // the value it must NOT inherit
    const registry = await twoRegionRegistry();
    const { app } = await serve(registry);
    const m = await mint(app, EU_KEY);
    expect(m.status).toBe(200);

    // Now the row goes bad underneath a still-valid token (a hand-edited/migrated row).
    const { app: app2 } = await serve(withBadRegion(registry, EU_TENANT, "atlantis"), {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const m2 = await mint(app2, US_KEY); // the other merchant is unaffected
    expect(m2.status).toBe(200);
    const bad = await chat(app2, m.token, "region-unset-1");
    expect(bad.statusCode).toBe(403);
    expect((bad.json() as { flags: string[] }).flags).toContain("merchant_region_unset");
    // NOT conflated with a revocation — they are different operator problems with different fixes.
    expect((bad.json() as { flags: string[] }).flags).not.toContain("merchant_inactive");
    await app.close();
    await app2.close();
  });

  it("/widget/token refuses too — a token we would reject on every turn must never be minted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { app } = await serve(withBadRegion(await twoRegionRegistry(), EU_TENANT, undefined));
    expect((await mint(app, EU_KEY)).status).toBe(401);
    expect((await mint(app, US_KEY)).status).toBe(200); // per-merchant, not a global outage
    await app.close();
  });

  it("a stale WIDGET_EMBED_KEYS entry cannot rescue it either (region never falls through to env)", async () => {
    process.env.WIDGET_EMBED_KEYS = JSON.stringify({ [EU_KEY]: EU_TENANT });
    process.env.MERCHANT_REGION = "us";
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { app } = await serve(withBadRegion(await twoRegionRegistry(), EU_TENANT, ""));
    expect((await mint(app, EU_KEY)).status).toBe(401);
    await app.close();
  });

  it("the refusal is AUDITED once per tenant per window, with a reversal path an operator can run", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, store } = await serve(withBadRegion(await twoRegionRegistry(), EU_TENANT, "atlantis"));
    await mint(app, EU_KEY);
    await mint(app, EU_KEY); // a second refusal must NOT append a second row
    const rows = (await store.readAudit({ tenantId: EU_TENANT })).filter((a) => a.action === "merchant.region_unset");
    expect(rows).toHaveLength(1);
    expect(rows[0].reversalPath).toContain("jobs/merchant.ts");
    expect(rows[0].reversalPath).toContain("--region"); // `set --tenant <t> --region …` really exists
    await app.close();
  });

  it("an audit failure can NEVER make a region-less merchant servable (a denial is not a governed write)", async () => {
    // D1's asymmetry, preserved: C1 audits a governed WRITE and aborts on audit failure; this audits a
    // governed DENIAL, so the refusal stands and the audit error is swallowed.
    const store = new InMemoryRuntimeStore();
    vi.spyOn(store, "audit").mockRejectedValue(new Error("audit chain unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = createMerchantResolver({
      store,
      registry: withBadRegion(await twoRegionRegistry(), EU_TENANT, "atlantis"),
      embedKeys: Object.create(null),
      storeDomains: () => Object.create(null),
      envRegion: "us",
      envGroundingMode: "full",
    });
    expect(await r.servability(EU_TENANT, "chat")).toMatchObject({ kind: "region-unset", tenantId: EU_TENANT });
  });

  it("grounding refuses the merchant's shop domain too — no catalog is pulled for a merchant we refuse", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = createMerchantResolver({
      store: new InMemoryRuntimeStore(),
      registry: withBadRegion(await twoRegionRegistry(), EU_TENANT, "atlantis"),
      embedKeys: Object.create(null),
      storeDomains: () => Object.assign(Object.create(null), { [EU_TENANT]: "stale-env-host.myshopify.com" }),
      envRegion: "us",
      envGroundingMode: "full",
    });
    expect(await r.shopDomainFor(EU_TENANT)).toBeUndefined(); // NOT the stale env host
    expect(await r.shopDomainFor(US_TENANT)).toBe("us-store.myshopify.com");
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe("D2 (4) the env values keep their D1 RANK: a named fallback for a tenant with no row", () => {
  it("staging's `demo` tenant (no pl_merchant row) still takes MERCHANT_REGION", async () => {
    process.env.MERCHANT_REGION = "eu";
    process.env.WIDGET_EMBED_KEYS = JSON.stringify({ "demo-embed-key": "demo" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { app } = await serve(createInMemoryMerchantRegistry()); // durable-shaped, but empty
    const m = await mint(app, "demo-embed-key");
    expect(m.status).toBe(200);
    expect((await chat(app, m.token, "demo-eu")).json().consentMode).toBe("opt_in");
    await app.close();
  });

  it("local/dev with no registry at all is unchanged: the env default still decides", async () => {
    const { app } = await serve(); // no registry — the e2e/eval posture
    const m = await mint(app, "demo-embed-key");
    expect((await chat(app, m.token, "demo-us")).json().consentMode).toBe("opt_out");
    await app.close();
  });

  it("groundingMode follows the same rank: the ROW wins over MERCHANT_GROUNDING_MODE", async () => {
    process.env.MERCHANT_GROUNDING_MODE = "full";
    const registry = await twoRegionRegistry();
    await registry.update(EU_TENANT, { groundingMode: "off" });
    const r = createMerchantResolver({
      store: new InMemoryRuntimeStore(),
      registry,
      embedKeys: Object.create(null),
      storeDomains: () => Object.create(null),
      envRegion: "us",
      envGroundingMode: "full",
    });
    expect(await r.servability(EU_TENANT, "chat")).toMatchObject({
      kind: "servable",
      config: { region: "eu", groundingMode: "off", source: "registry" },
    });
    // ...and a tenant with no row takes both env values, reported as such.
    expect(await r.servability("demo", "chat")).toMatchObject({
      kind: "servable",
      config: { region: "us", groundingMode: "full", source: "env" },
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe("D2 (5) a response never CLAIMS a regime it could not resolve", () => {
  it("the unauthenticated early return reports the STRICTEST regime, not the process default", async () => {
    // This return fires before any tenant is known, so `opt_out` there would be a statement about a
    // merchant we have not identified. `consentPermits` itself gives an unknown region the stricter
    // treatment (ADR-0015 Inv 3) — this is the same rule, on the wire.
    process.env.MERCHANT_REGION = "us";
    process.env.WIDGET_AUTH_REQUIRED = "true";
    const { app } = await serve(await twoRegionRegistry());
    const res = await chat(app, undefined, "noauth-1");
    expect(res.statusCode).toBe(401);
    expect(res.json().consentMode).toBe("opt_in");
    await app.close();
  });

  it("so does the refusal path (a merchant we will not serve has no serving regime)", async () => {
    process.env.MERCHANT_REGION = "us";
    const registry = await twoRegionRegistry();
    const { app } = await serve(registry);
    const m = await mint(app, US_KEY);
    await registry.setStatus(US_TENANT, "uninstalled", { reason: "app/uninstalled webhook" });
    const res = await chat(app, m.token, "revoked-1");
    expect(res.statusCode).toBe(403);
    expect(res.json().consentMode).toBe("opt_in");
    await app.close();
  });

  it("the oversize early return keeps carrying the field (PR-11b's contract) at the strictest regime", async () => {
    process.env.MERCHANT_REGION = "us";
    const { app } = await serve(await twoRegionRegistry());
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "big", message: "a".repeat(5000), signals: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().consentMode).toBe("opt_in");
    await app.close();
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe("D2 (6) the region -> consent-regime rule lives in exactly ONE place", () => {
  it("consentModeFor mirrors ADR-0015: US is opt-out, EVERY other region — and an unknown one — is opt-in", () => {
    expect(consentModeFor("us")).toBe("opt_out");
    expect(consentModeFor("eu")).toBe("opt_in");
    expect(consentModeFor("uk")).toBe("opt_in");
    expect(consentModeFor("other")).toBe("opt_in");
    // The fail-closed direction, matching `consentPermits(undefined, "ordinary", …)`.
    expect(consentModeFor(undefined)).toBe("opt_in");
  });
});
