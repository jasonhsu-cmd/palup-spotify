import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import {
  setCatalogRetrievalPlatformEnabled,
  setCatalogRetrievalTenantOptIn,
  catalogRetrievalEnabledFor,
} from "@palup/state-postgres";

const here = dirname(fileURLToPath(import.meta.url));

describe("serving — per-tenant CATALOG_RETRIEVAL resolution", () => {
  it("resolves true for an opted-in tenant and false for another under the same master", async () => {
    const store = new InMemoryRuntimeStore();
    await setCatalogRetrievalPlatformEnabled(store, true, { reason: "master" });
    await setCatalogRetrievalTenantOptIn(store, "acme", true, { reason: "canary" });
    expect(await catalogRetrievalEnabledFor(store, "acme")).toBe(true);
    expect(await catalogRetrievalEnabledFor(store, "beta")).toBe(false);
  });

  it("no process.env.CATALOG_RETRIEVAL read survives in server.ts (the env is retired — S4 §B)", () => {
    const src = readFileSync(join(here, "..", "src", "server.ts"), "utf8");
    expect(src).not.toMatch(/process\.env\.CATALOG_RETRIEVAL\b/);
  });
});
