import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore, createInMemoryMerchantRegistry } from "@palup/platform-ports";
import type { MerchantRegistryPort, RuntimeStatePort } from "@palup/platform-ports";
import {
  MERCHANT_USAGE,
  MerchantArgsError,
  parseMerchantArgv,
  resolveMerchantStore,
  runMerchant,
} from "../src/jobs/merchant.js";

// C1 — the operator CLI that makes the install's audit `reversalPath` REAL.
//
// #179 is the reason this file exists at all: a reversalPath in an immutable record has to name something an
// operator can actually RUN against the deployment that exists. `deploy-staging.yml` deploys
// `palup-widget-staging` only and the control plane is deployed nowhere, so the reversal for
// "merchant.registered" cannot be an HTTP route. It is THIS tool, and these tests are what stop it from
// being a promise. Same shape and same store discipline as jobs/kill-switch.ts and jobs/cost-cap.ts.

async function fixture(): Promise<{ store: RuntimeStatePort; registry: MerchantRegistryPort }> {
  const store = new InMemoryRuntimeStore();
  const registry = createInMemoryMerchantRegistry();
  await registry.create({ tenantId: "acme-store", shopDomain: "acme-store.myshopify.com", embedKey: "pk_acme", region: "us" });
  return { store, registry };
}

describe("merchant CLI — argument parsing refuses anything implicit", () => {
  it("refuses an unknown or missing subcommand", () => {
    for (const argv of [[], [""], ["delete"], ["Status"]]) {
      expect(() => parseMerchantArgv(argv)).toThrow(MerchantArgsError);
    }
  });

  it("`status` requires BOTH an explicit --tenant and an explicit --status (never a default)", () => {
    expect(() => parseMerchantArgv(["status"])).toThrow(/--tenant/);
    expect(() => parseMerchantArgv(["status", "--tenant", "acme-store"])).toThrow(/--status/);
    expect(() => parseMerchantArgv(["status", "--status", "uninstalled"])).toThrow(/--tenant/);
    expect(() => parseMerchantArgv(["status", "--tenant", "  ", "--status", "active"])).toThrow(/--tenant/);
    expect(() => parseMerchantArgv(["status", "--tenant", "acme-store", "--status", "deleted"])).toThrow(/--status/);
  });

  it("parses a valid status change, carrying the operator's reason", () => {
    expect(parseMerchantArgv(["status", "--tenant", "acme-store", "--status", "uninstalled", "--reason", "app/uninstalled"])).toEqual({
      action: "status",
      tenantId: "acme-store",
      status: "uninstalled",
      reason: "app/uninstalled",
    });
  });

  it("`show` needs only a tenant; `set` needs a tenant plus at least one field to change", () => {
    expect(parseMerchantArgv(["show", "--tenant", "acme-store"])).toEqual({ action: "show", tenantId: "acme-store" });
    expect(() => parseMerchantArgv(["set", "--tenant", "acme-store"])).toThrow(/at least one/);
    expect(() => parseMerchantArgv(["set", "--tenant", "acme-store", "--region", "atlantis"])).toThrow(/--region/);
    expect(() => parseMerchantArgv(["set", "--tenant", "acme-store", "--grounding-mode", "loud"])).toThrow(/--grounding-mode/);
    expect(parseMerchantArgv(["set", "--tenant", "acme-store", "--region", "eu", "--plan", "growth"])).toEqual({
      action: "set",
      tenantId: "acme-store",
      region: "eu",
      plan: "growth",
    });
  });

  it("the usage text names the runnable invocation, not a route or a console", () => {
    expect(MERCHANT_USAGE).toContain("jobs/merchant.ts");
    expect(MERCHANT_USAGE).not.toMatch(/https?:|POST \/|control-plane/);
  });
});

describe("merchant CLI — status changes are confirmed by reading back, and audited (NN#5)", () => {
  it("uninstall makes the merchant INERT and is audited with a reversal that restores it", async () => {
    const { store, registry } = await fixture();
    const report = await runMerchant({ store, registry }, { action: "status", tenantId: "acme-store", status: "uninstalled", reason: "app/uninstalled" });
    expect(report.confirmed).toBe(true);
    expect(report.merchant?.status).toBe("uninstalled");
    // Default-inert: every ordinary lookup now resolves to null, which is what revocation MEANS here.
    expect(await registry.lookupByShopDomain("acme-store.myshopify.com")).toBeNull();
    expect(await registry.lookupByEmbedKey("pk_acme")).toBeNull();
    expect(await registry.lookupByShopDomain("acme-store.myshopify.com", { includeInactive: true })).toBeTruthy();

    const log = await store.readAudit({ tenantId: "acme-store" });
    const rec = log.find((r) => r.action === "merchant.status_changed");
    expect(rec).toBeTruthy();
    expect(rec?.actor).toBe("operator");
    expect(rec?.reversalPath).toContain("jobs/merchant.ts");
    expect(rec?.reversalPath).toContain("active");
    expect(rec?.reversalPath).not.toMatch(/https?:|POST \/|control-plane/);
    expect((await store.verifyAudit({ tenantId: "acme-store" })).ok).toBe(true);
  });

  it("the reversal actually works — active again, servable again", async () => {
    const { store, registry } = await fixture();
    await runMerchant({ store, registry }, { action: "status", tenantId: "acme-store", status: "uninstalled" });
    await runMerchant({ store, registry }, { action: "status", tenantId: "acme-store", status: "active", reason: "re-enabled" });
    expect((await registry.lookupByShopDomain("acme-store.myshopify.com"))?.status).toBe("active");
    expect((await store.readAudit({ tenantId: "acme-store" })).filter((r) => r.action === "merchant.status_changed")).toHaveLength(2);
  });

  it("audits `update` too, as its own action — all three governed writes are covered", async () => {
    const { store, registry } = await fixture();
    const report = await runMerchant({ store, registry }, { action: "set", tenantId: "acme-store", region: "eu", plan: "growth" });
    expect(report.merchant?.region).toBe("eu");
    expect(report.merchant?.plan).toBe("growth");
    const rec = (await store.readAudit({ tenantId: "acme-store" })).find((r) => r.action === "merchant.updated");
    expect(rec).toBeTruthy();
    expect(rec?.input).toEqual({ tenantId: "acme-store", region: "eu", plan: "growth" });
    expect(rec?.reversalPath).toContain("jobs/merchant.ts");
    expect((await store.verifyAudit({ tenantId: "acme-store" })).ok).toBe(true);
  });

  it("`show` reads without writing — no audit noise for a read", async () => {
    const { store, registry } = await fixture();
    const report = await runMerchant({ store, registry }, { action: "show", tenantId: "acme-store" });
    expect(report.merchant?.tenantId).toBe("acme-store");
    expect(await store.readAudit({ tenantId: "acme-store" })).toEqual([]);
  });

  it("an unknown tenant FAILS loudly and creates nothing", async () => {
    const { store, registry } = await fixture();
    await expect(runMerchant({ store, registry }, { action: "status", tenantId: "nobody", status: "uninstalled" })).rejects.toThrow();
    await expect(runMerchant({ store, registry }, { action: "set", tenantId: "nobody", region: "eu" })).rejects.toThrow();
    expect(await registry.lookupByTenantId("nobody", { includeInactive: true })).toBeNull();
  });

  it("an AUDIT failure aborts before the registry is touched (an unauditable governed write must not persist)", async () => {
    const { store, registry } = await fixture();
    const failing: RuntimeStatePort = { ...store, audit: async () => { throw new Error("audit sink unavailable"); } };
    await expect(
      runMerchant({ store: failing, registry }, { action: "status", tenantId: "acme-store", status: "uninstalled" }),
    ).rejects.toThrow(/audit/);
    expect((await registry.lookupByTenantId("acme-store"))?.status).toBe("active"); // untouched
  });

  it("never writes a secret into the audit record", async () => {
    const { store, registry } = await fixture();
    await runMerchant({ store, registry }, { action: "status", tenantId: "acme-store", status: "uninstalled", reason: "shpat_NOT_A_REASON" });
    // The operator's own free-text reason is stored (it is operator input, not a credential), but nothing
    // token-shaped is ever DERIVED or fetched by this tool: it has no access to the credential store at all.
    const json = JSON.stringify(await store.readAudit({ tenantId: "acme-store" }));
    expect(json).not.toContain("access_token");
    expect(json).not.toContain("client_secret");
  });
});

describe("merchant CLI — custom-domain CSP support (`set --primary-domain`)", () => {
  it("parses --primary-domain, normalized, and requires a bare hostname", () => {
    expect(parseMerchantArgv(["set", "--tenant", "acme-store", "--primary-domain", "Shop.Example.com"])).toEqual({
      action: "set",
      tenantId: "acme-store",
      primaryDomain: "shop.example.com",
    });
    expect(() =>
      parseMerchantArgv(["set", "--tenant", "acme-store", "--primary-domain", "https://shop.example.com"]),
    ).toThrow(/--primary-domain/);
    expect(() => parseMerchantArgv(["set", "--tenant", "acme-store", "--primary-domain", "shop example.com"])).toThrow(
      /--primary-domain/,
    );
  });

  it("sets and reads back a primaryDomain (round trip), and it is auditable + reversible (NN#5)", async () => {
    const { store, registry } = await fixture();
    const report = await runMerchant(
      { store, registry },
      { action: "set", tenantId: "acme-store", primaryDomain: "Shop.Example.com" },
    );
    expect(report.merchant?.primaryDomain).toBe("shop.example.com"); // registry normalizes on write
    expect((await registry.lookupByTenantId("acme-store"))?.primaryDomain).toBe("shop.example.com");

    const rec = (await store.readAudit({ tenantId: "acme-store" })).find((r) => r.action === "merchant.updated");
    expect(rec).toBeTruthy();
    expect(rec?.reversalPath).toContain("--primary-domain");
    expect((await store.verifyAudit({ tenantId: "acme-store" })).ok).toBe(true);

    // The reversal actually restores the PREVIOUS value (here, "unset" since none was configured before).
    expect(rec?.reversalPath).toContain("(unset");
  });

  it("a malformed primaryDomain (bypassing parseMerchantArgv's own guard) is rejected by the registry's " +
    "write-time validation and leaves the row untouched", async () => {
    const { store, registry } = await fixture();
    await expect(
      runMerchant({ store, registry }, { action: "set", tenantId: "acme-store", primaryDomain: "https://evil.com" }),
    ).rejects.toThrow();
    expect((await registry.lookupByTenantId("acme-store"))?.primaryDomain).toBeUndefined();
  });
});

describe("merchant CLI — it refuses a store nobody else can see", () => {
  it("without DATABASE_URL it hard-fails instead of silently using a per-process store", async () => {
    await expect(resolveMerchantStore({} as NodeJS.ProcessEnv)).rejects.toThrow(/DATABASE_URL/);
  });
});
