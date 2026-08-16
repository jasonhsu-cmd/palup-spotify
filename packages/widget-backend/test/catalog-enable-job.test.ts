import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { catalogRetrievalEnabledFor } from "@palup/state-postgres";
import {
  parseCatalogEnableArgv,
  runCatalogEnable,
  CatalogEnableArgsError,
} from "../src/jobs/catalog-enable.js";

describe("catalog-enable — argv parsing", () => {
  it("parses a tenant opt-in on", () => {
    expect(parseCatalogEnableArgv(["--scope", "tenant:acme", "--on", "--reason", "canary"])).toEqual({
      scope: "tenant:acme",
      on: true,
      reason: "canary",
    });
  });
  it("parses the platform master off", () => {
    expect(parseCatalogEnableArgv(["--scope", "platform", "--off"])).toEqual({ scope: "platform", on: false });
  });
  it("refuses a missing scope (never an implicit one)", () => {
    expect(() => parseCatalogEnableArgv(["--on"])).toThrow(CatalogEnableArgsError);
  });
  it("refuses an unparseable scope", () => {
    expect(() => parseCatalogEnableArgv(["--scope", "everyone", "--on"])).toThrow(/global|tenant:/);
  });
  it("refuses when neither --on nor --off is given, and when both are", () => {
    expect(() => parseCatalogEnableArgv(["--scope", "platform"])).toThrow(CatalogEnableArgsError);
    expect(() => parseCatalogEnableArgv(["--scope", "platform", "--on", "--off"])).toThrow(CatalogEnableArgsError);
  });
});

describe("catalog-enable — runs against the store, audits, reads back", () => {
  it("sets a tenant opt-in and reports the effective (both-gate) state", async () => {
    const store = new InMemoryRuntimeStore();
    const r1 = await runCatalogEnable({ store }, { scope: "tenant:acme", on: true, reason: "canary" });
    expect(r1.tenantOptIn).toBe(true);
    expect(r1.effective).toBe(false); // master still off
    expect(await catalogRetrievalEnabledFor(store, "acme")).toBe(false);

    const r2 = await runCatalogEnable({ store }, { scope: "platform", on: true });
    expect(r2.platformEnabled).toBe(true);
    expect(await catalogRetrievalEnabledFor(store, "acme")).toBe(true);

    const audit = await store.readAudit({ tenantId: "acme" });
    expect(audit.at(-1)!.action).toBe("catalog_retrieval.tenant_optin.enable");
  });

  it("sets a tenant opt-in off and audits the disable action distinctly", async () => {
    const store = new InMemoryRuntimeStore();
    await runCatalogEnable({ store }, { scope: "tenant:acme", on: true });
    const r = await runCatalogEnable({ store }, { scope: "tenant:acme", on: false, reason: "rollback" });
    expect(r.tenantOptIn).toBe(false);
    expect(r.effective).toBe(false);
    expect(await catalogRetrievalEnabledFor(store, "acme")).toBe(false);

    const audit = await store.readAudit({ tenantId: "acme" });
    expect(audit.at(-1)!.action).toBe("catalog_retrieval.tenant_optin.disable");
  });

  it("sets the platform master off and audits the disable action distinctly", async () => {
    const store = new InMemoryRuntimeStore();
    await runCatalogEnable({ store }, { scope: "platform", on: true });
    const r = await runCatalogEnable({ store }, { scope: "platform", on: false, reason: "halt" });
    expect(r.platformEnabled).toBe(false);

    const audit = await store.readAudit({ tenantId: "__system__" });
    expect(audit.at(-1)!.action).toBe("catalog_retrieval.platform.disable");
  });
});
