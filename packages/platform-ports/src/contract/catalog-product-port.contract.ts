import { it, expect } from "vitest";
import type { CatalogProductPort, CatalogProductRecord } from "../catalog-product-port.js";

const rec = (id: string, over: Partial<CatalogProductRecord> = {}): CatalogProductRecord => ({
  productId: id, handle: id, title: id, status: "active", variants: [],
  contentHash: "h", syncedAt: "2026-08-23T00:00:00.000Z", ...over,
});

export function runCatalogProductPortContract(make: () => Promise<CatalogProductPort>) {
  it("upsert then getMany returns the row", async () => {
    const s = await make();
    await s.upsertMany("t1", [rec("gid://shopify/Product/1", { title: "Serum" })]);
    const got = await s.getMany("t1", ["gid://shopify/Product/1"]);
    expect(got).toHaveLength(1);
    expect(got[0]!.title).toBe("Serum");
  });
  it("tenant isolation: t2 cannot read t1's rows", async () => {
    const s = await make();
    await s.upsertMany("t1", [rec("gid://shopify/Product/1")]);
    expect(await s.getMany("t2", ["gid://shopify/Product/1"])).toEqual([]);
  });
  it("blank tenant throws (fail closed)", async () => {
    const s = await make();
    await expect(s.getMany("", ["x"])).rejects.toThrow();
  });
  it("softDelete tombstones: getMany excludes it, includeDeleted lists it", async () => {
    const s = await make();
    await s.upsertMany("t1", [rec("gid://shopify/Product/1")]);
    await s.softDeleteMany("t1", ["gid://shopify/Product/1"], { at: "2026-08-24T00:00:00.000Z" });
    expect(await s.getMany("t1", ["gid://shopify/Product/1"])).toEqual([]);
    const all = await s.listByTenant("t1", { includeDeleted: true });
    expect(all[0]!.deletedAt).toBe("2026-08-24T00:00:00.000Z");
  });
  it("pruneTombstoned hard-deletes rows tombstoned before the cutoff", async () => {
    const s = await make();
    await s.upsertMany("t1", [rec("gid://shopify/Product/1")]);
    await s.softDeleteMany("t1", ["gid://shopify/Product/1"], { at: "2026-08-24T00:00:00.000Z" });
    const n = await s.pruneTombstoned("t1", { olderThan: "2026-08-25T00:00:00.000Z" });
    expect(n).toBe(1);
    expect(await s.listByTenant("t1", { includeDeleted: true })).toEqual([]);
  });
}
