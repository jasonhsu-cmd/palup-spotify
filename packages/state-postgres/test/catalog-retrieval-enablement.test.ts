import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import {
  readPlatformEnabled,
  readTenantOptIn,
  catalogRetrievalEnabledFor,
  setPlatformEnabled,
  setTenantOptIn,
  CATALOG_RETRIEVAL_PLATFORM_TENANT,
} from "../src/catalog-retrieval-enablement.js";

describe("catalog-retrieval-enablement — gate truth table (both default OFF)", () => {
  it("is false for everyone when nothing is set", async () => {
    const store = new InMemoryRuntimeStore();
    expect(await readPlatformEnabled(store)).toBe(false);
    expect(await readTenantOptIn(store, "t1")).toBe(false);
    expect(await catalogRetrievalEnabledFor(store, "t1")).toBe(false);
  });

  it("requires BOTH master AND tenant opt-in", async () => {
    const store = new InMemoryRuntimeStore();
    await setTenantOptIn(store, "t1", true, { actor: "jason", reason: "canary" });
    expect(await catalogRetrievalEnabledFor(store, "t1")).toBe(false); // master still off

    await setPlatformEnabled(store, true, { actor: "jason", reason: "open the master" });
    expect(await catalogRetrievalEnabledFor(store, "t1")).toBe(true); // both on

    expect(await catalogRetrievalEnabledFor(store, "t2")).toBe(false); // t2 never opted in
    await setPlatformEnabled(store, false, { actor: "jason", reason: "close the master" });
    expect(await catalogRetrievalEnabledFor(store, "t1")).toBe(false); // master wins
  });

  it("setters write an atomic audit row naming the actor and the reversal path", async () => {
    const store = new InMemoryRuntimeStore();
    await setTenantOptIn(store, "t1", true, { actor: "jason", reason: "canary #295" });
    const audit = await store.readAudit({ tenantId: "t1" });
    expect(audit.at(-1)).toMatchObject({
      actor: "jason",
      action: "catalog_retrieval.tenant_optin.enable",
    });
    expect(audit.at(-1)!.reversalPath).toContain("catalog:enable");

    await setPlatformEnabled(store, true, { reason: "master" });
    const sysAudit = await store.readAudit({ tenantId: CATALOG_RETRIEVAL_PLATFORM_TENANT });
    expect(sysAudit.at(-1)).toMatchObject({ action: "catalog_retrieval.platform.enable" });
    expect(sysAudit.at(-1)!.actor).toBe("operator"); // default actor when none supplied
  });

  it("refuses the reserved __system__ tenant as a merchant opt-in", async () => {
    const store = new InMemoryRuntimeStore();
    await expect(setTenantOptIn(store, CATALOG_RETRIEVAL_PLATFORM_TENANT, true)).rejects.toThrow(/real merchant/);
  });
});
