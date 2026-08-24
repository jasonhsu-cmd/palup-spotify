import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { NewMerchant } from "@palup/platform-ports";
import { PostgresMerchantRegistry } from "../src/postgres-merchant-registry.js";
import type { Sql } from "../src/sql.js";

// Governed cross-tenant enumeration (ADR-0023): `listActive(cursor)` is the first PAGINATED, active-only,
// secret-free scan over pl_merchant. Everything else on MerchantRegistryPort is a point lookup by an
// already-known key (tenantId/shopDomain/embedKey); this is the one method that walks every active
// tenant, so it gets its own dedicated coverage here on top of the shared port contract (which also runs
// an equivalent case against BOTH adapters — see merchant-registry-port.contract.ts).

function pgliteSql(db: PGlite): Sql {
  const wrap = (runner: { query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }): Sql => ({
    query: async <R = Record<string, unknown>>(text: string, params: unknown[] = []) => {
      const r = await runner.query(text, params);
      return { rows: r.rows as R[] };
    },
    tx: () => {
      throw new Error("nested transactions are not supported");
    },
  });
  return {
    query: wrap(db).query,
    tx: (fn) => db.transaction(async (txCtx) => fn(wrap(txCtx))),
  };
}

async function makeAdapter(): Promise<PostgresMerchantRegistry> {
  const reg = new PostgresMerchantRegistry(pgliteSql(new PGlite()));
  await reg.migrate();
  return reg;
}

const merchant = (tenantId: string): NewMerchant => ({
  tenantId,
  shopDomain: `${tenantId}.myshopify.com`,
  embedKey: `pk-${tenantId}`,
  region: "us",
});

describe("PostgresMerchantRegistry.listActive — governed enumeration (ADR-0023)", () => {
  it("paginates active-only, secret-free, in tenant_id order; excludes uninstalled merchants", async () => {
    const r = await makeAdapter();
    await r.create(merchant("t-a"));
    await r.create(merchant("t-b"));
    await r.setStatus("t-b", "uninstalled", { reason: "app/uninstalled webhook" });
    await r.create(merchant("t-c"));
    await r.create(merchant("t-d"));

    const page1 = await r.listActive({ limit: 2 });
    expect(page1.items).toEqual([
      { tenantId: "t-a", shopDomain: "t-a.myshopify.com", status: "active" },
      { tenantId: "t-c", shopDomain: "t-c.myshopify.com", status: "active" },
    ]);
    expect(page1.nextCursor).toBe("t-c");

    const page2 = await r.listActive({ cursor: page1.nextCursor, limit: 2 });
    expect(page2.items).toEqual([{ tenantId: "t-d", shopDomain: "t-d.myshopify.com", status: "active" }]);
    expect(page2.nextCursor).toBeUndefined();

    // t-b (uninstalled) must never appear, and no item may carry a secret/token field or any column
    // beyond the allowlist {tenantId, shopDomain, status}.
    const allItems = [...page1.items, ...page2.items];
    expect(allItems.map((i) => i.tenantId)).not.toContain("t-b");
    for (const item of allItems) {
      expect(Object.keys(item).sort()).toEqual(["shopDomain", "status", "tenantId"]);
      expect(item).not.toHaveProperty("token");
      expect(item).not.toHaveProperty("embedKey");
      expect(item).not.toHaveProperty("region");
    }
  });

  it("defaults limit to 500 and does not error when a limit above 1000 is clamped down", async () => {
    const r = await makeAdapter();
    await r.create(merchant("solo"));
    const page = await r.listActive();
    expect(page.items).toEqual([{ tenantId: "solo", shopDomain: "solo.myshopify.com", status: "active" }]);
    expect(page.nextCursor).toBeUndefined();

    const clamped = await r.listActive({ limit: 5000 });
    expect(clamped.items).toHaveLength(1);
    expect(clamped.nextCursor).toBeUndefined();
  });

  it("an empty registry returns an empty page with no nextCursor", async () => {
    const r = await makeAdapter();
    const page = await r.listActive();
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
  });
});
