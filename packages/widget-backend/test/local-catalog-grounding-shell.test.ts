import { describe, it, expect } from "vitest";
import {
  createInMemoryCatalogProductStore,
  createInMemoryProductFactsStore,
  createInMemoryStoreProfileStore,
} from "@palup/platform-ports";
import { createLocalCatalogGroundingPort } from "../src/local-catalog-grounding.js";

// Task 4 (credential-enrollment-unification, spec §Task 4): `getShell` can be served entirely from the
// local `store_profile` store — no `shellSource`/Shopify call on this path — when `unifiedLocalShell` is
// set (Task 7/CATALOG_UNIFIED). Final-review Critical fix (2026-08-24): `getShell` initially read
// store_profile UNCONDITIONALLY, ignoring the flag (a gap from before `unifiedLocalShell` existed); it is
// now gated exactly like `getContext`, so every case below constructs the port WITH the flag set. The
// flag-OFF (`shellSource`) case is covered by local-catalog-grounding.test.ts's own getShell coverage and
// server-catalog-unified-wiring.test.ts's flag-OFF regression test.

describe("createLocalCatalogGroundingPort — getShell from local store_profile (Task 4/7, unifiedLocalShell)", () => {
  it("returns the tenant's brand/policy from store_profile, with no shellSource call", async () => {
    const catalogProduct = createInMemoryCatalogProductStore();
    const productFacts = createInMemoryProductFactsStore();
    const storeProfile = createInMemoryStoreProfileStore();
    await storeProfile.put("t1", {
      brandName: "Acme",
      policy: { returns: "30d", shipping: "free", allergens: "contains nuts" },
    });

    let shellSourceCalled = false;
    const shellSource = {
      getShell: async () => {
        shellSourceCalled = true;
        throw new Error("shellSource must never be called from getShell");
      },
    };

    const grounding = createLocalCatalogGroundingPort({ catalogProduct, productFacts, shellSource, storeProfile, unifiedLocalShell: true });
    const shell = await grounding.getShell("t1");

    expect(shell).toEqual({
      tenantId: "t1",
      brandName: "Acme",
      policy: { returns: "30d", shipping: "free", allergens: "contains nuts" },
    });
    expect(shellSourceCalled).toBe(false);
  });

  it("degrades to the neutral default (never throws) when no profile has been set for the tenant", async () => {
    const catalogProduct = createInMemoryCatalogProductStore();
    const productFacts = createInMemoryProductFactsStore();
    const storeProfile = createInMemoryStoreProfileStore();

    const shellSource = {
      getShell: async () => {
        throw new Error("shellSource must never be called from getShell");
      },
    };

    const grounding = createLocalCatalogGroundingPort({ catalogProduct, productFacts, shellSource, storeProfile, unifiedLocalShell: true });
    const shell = await grounding.getShell("missing-tenant");

    expect(shell).toEqual({
      tenantId: "missing-tenant",
      brandName: "this store",
      policy: { returns: "", shipping: "" },
    });
  });

  it("degrades to the neutral default (never throws) when store_profile.get itself errors", async () => {
    const catalogProduct = createInMemoryCatalogProductStore();
    const productFacts = createInMemoryProductFactsStore();
    const storeProfile = {
      get: async () => {
        throw new Error("db is down");
      },
    };
    const shellSource = {
      getShell: async () => {
        throw new Error("shellSource must never be called from getShell");
      },
    };

    const grounding = createLocalCatalogGroundingPort({ catalogProduct, productFacts, shellSource, storeProfile, unifiedLocalShell: true });
    const shell = await grounding.getShell("t1");

    expect(shell).toEqual({
      tenantId: "t1",
      brandName: "this store",
      policy: { returns: "", shipping: "" },
    });
  });
});
