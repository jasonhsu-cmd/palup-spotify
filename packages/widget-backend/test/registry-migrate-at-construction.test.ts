import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";

// STAGING WAS DOWN BECAUSE OF THIS. Confirmed from the live deployment, not inferred:
//
//   /health            -> {"ok":true,"store":"postgres","vector":"postgres","merchants":"registry+env"}
//   POST /widget/token -> 401
//   Cloud Run log      -> "[merchant] registry lookup (lookupByEmbedKey) FAILED while resolving for
//                          embed-key-mint — refusing to resolve."
//
// The cause was a COUPLING BUG between D1 and C1/C2, not a database permission:
//
//   * D1 made EVERY token mint read `pl_merchant`, and made an unreadable registry fail CLOSED (correctly
//     — an unreadable registry is not an absent row, so a database fault must not resurrect a revoked
//     merchant through the env fallback).
//   * But the table's `CREATE TABLE IF NOT EXISTS` lived inside `if (SHOPIFY_INSTALL_ENABLED)` and
//     `if (SHOPIFY_WEBHOOKS_ENABLED)` — C1's and C2's feature gates.
//   * The registry itself is constructed unconditionally from `DATABASE_URL`.
//
// So a deployment with `DATABASE_URL` but no Shopify app credentials — which is exactly what staging is —
// constructed a registry over a table that was never created, and then refused every request. The two
// halves were individually correct and jointly fatal.
//
// The DDL now runs where the registry is constructed, matching `createRuntimeStore` /
// `createVectorStore`, which have always migrated at construction (and whose tables therefore exist —
// which is also the proof that the database role has CREATE and that no grant was ever missing).

/** A registry double that records whether the server migrated it. */
function spyRegistry() {
  const calls: string[] = [];
  return {
    calls,
    registry: {
      async migrate() { calls.push("migrate"); },
      async lookupByEmbedKey() { return null; },
      async lookupByTenantId() { return null; },
      async lookupByShopDomain() { return null; },
      async create() { throw new Error("not used"); },
      async update() { throw new Error("not used"); },
      async setStatus() { throw new Error("not used"); },
    },
  };
}

describe("the merchant registry is migrated where it is CONSTRUCTED, not where a feature is enabled", () => {
  it("THE DEFECT: migrates with the Shopify install/webhook features OFF", async () => {
    // Staging's exact shape: a durable registry, no Shopify app credentials.
    const { calls, registry } = spyRegistry();
    const app = await buildServer({ store: new InMemoryRuntimeStore(), merchantRegistry: registry as never });
    try {
      expect(calls, "the registry was constructed but never migrated — serving reads a table nobody created").toContain("migrate");
    } finally {
      await app.close();
    }
  });

  it("migrates exactly once per boot, not once per feature that happens to be on", async () => {
    const { calls, registry } = spyRegistry();
    const app = await buildServer({ store: new InMemoryRuntimeStore(), merchantRegistry: registry as never });
    try {
      expect(calls.filter((c) => c === "migrate")).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("a registry with no migrate() is left alone — the seam must not require one", async () => {
    // Several existing suites inject minimal doubles. Requiring `migrate` would break them, and a
    // capability check is also the honest rule: migrate what can be migrated.
    const bare = {
      async lookupByEmbedKey() { return null; },
      async lookupByTenantId() { return null; },
      async lookupByShopDomain() { return null; },
    };
    const app = await buildServer({ store: new InMemoryRuntimeStore(), merchantRegistry: bare as never });
    try {
      expect(app).toBeTruthy(); // booted without throwing
    } finally {
      await app.close();
    }
  });

  it("a boot with NO durable registry still boots — pure-env deployments are unaffected", async () => {
    const app = await buildServer({ store: new InMemoryRuntimeStore() });
    try {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
