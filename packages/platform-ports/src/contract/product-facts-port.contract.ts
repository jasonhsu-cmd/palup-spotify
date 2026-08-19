import { describe, it, expect } from "vitest";
import type { ProductFactsPort, ProductFact } from "../product-facts-port.js";

// Port contract (ADR-0001; ADR-0020 D2): every ProductFactsPort adapter (in-memory, Postgres, …) MUST
// pass this, so adapters stay behavior-equivalent and the engine stays swappable. `makeAdapter` returns a
// FRESH, empty adapter each call — async so a Postgres adapter can migrate/connect per test.
export function runProductFactsPortContract(makeAdapter: () => ProductFactsPort | Promise<ProductFactsPort>): void {
  describe("ProductFactsPort contract", () => {
    const f = (productId: string, price: string, extra: Partial<ProductFact> = {}): ProductFact => ({
      productId,
      price,
      ...extra,
    });

    it("upsertMany + getMany hydrates exactly the requested ids", async () => {
      const s = await makeAdapter();
      await s.upsertMany("tenant-a", [
        f("p1", "$18", { availableForSale: true, currency: "USD", source: "poll" }),
        f("p2", "$34"),
        f("p3", "$26", { availableForSale: false }),
      ]);
      const got = await s.getMany("tenant-a", ["p1", "p3"]);
      expect(got.map((x) => x.productId).sort()).toEqual(["p1", "p3"]);
      expect(got.find((x) => x.productId === "p1")).toEqual(
        f("p1", "$18", { availableForSale: true, currency: "USD", source: "poll" }),
      );
      expect(got.find((x) => x.productId === "p3")).toEqual(f("p3", "$26", { availableForSale: false }));
    });

    it("omits ids with no stored fact (never invents)", async () => {
      const s = await makeAdapter();
      await s.upsertMany("t", [f("p1", "$1")]);
      const got = await s.getMany("t", ["p1", "does-not-exist"]);
      expect(got.map((x) => x.productId)).toEqual(["p1"]);
    });

    it("returns one fact per DISTINCT id even if the request repeats an id", async () => {
      const s = await makeAdapter();
      await s.upsertMany("t", [f("p1", "$1")]);
      const got = await s.getMany("t", ["p1", "p1", "p1"]);
      expect(got.map((x) => x.productId)).toEqual(["p1"]);
    });

    it("empty id list returns []", async () => {
      const s = await makeAdapter();
      await s.upsertMany("t", [f("p1", "$1")]);
      expect(await s.getMany("t", [])).toEqual([]);
    });

    it("upsertMany overwrites an existing product's fact (fresh price wins)", async () => {
      const s = await makeAdapter();
      await s.upsertMany("t", [f("p1", "$18", { availableForSale: true })]);
      await s.upsertMany("t", [f("p1", "$16", { availableForSale: false })]);
      expect(await s.getMany("t", ["p1"])).toEqual([f("p1", "$16", { availableForSale: false })]);
    });

    it("is tenant-isolated — one tenant never sees another's facts", async () => {
      const s = await makeAdapter();
      await s.upsertMany("tenant-a", [f("p1", "$18")]);
      await s.upsertMany("tenant-b", [f("p1", "$99")]);
      expect(await s.getMany("tenant-b", ["p1"])).toEqual([f("p1", "$99")]);
      expect(await s.getMany("tenant-c", ["p1"])).toEqual([]);
    });

    it("deleteMany removes exactly the named ids and leaves the rest (delist-prune)", async () => {
      const s = await makeAdapter();
      await s.upsertMany("t", [f("p1", "$1"), f("p2", "$2"), f("p3", "$3")]);
      await s.deleteMany("t", ["p2", "does-not-exist"]); // absent id is ignored (idempotent)
      expect((await s.getMany("t", ["p1", "p2", "p3"])).map((x) => x.productId).sort()).toEqual(["p1", "p3"]);
    });

    it("deleteMany with an empty id list is a no-op", async () => {
      const s = await makeAdapter();
      await s.upsertMany("t", [f("p1", "$1")]);
      await s.deleteMany("t", []);
      expect((await s.getMany("t", ["p1"])).map((x) => x.productId)).toEqual(["p1"]);
    });

    it("deleteMany is tenant-isolated — pruning one tenant never touches another's identically-keyed rows", async () => {
      const s = await makeAdapter();
      await s.upsertMany("tenant-a", [f("p1", "$1")]);
      await s.upsertMany("tenant-b", [f("p1", "$9")]);
      await s.deleteMany("tenant-a", ["p1"]);
      expect(await s.getMany("tenant-a", ["p1"])).toEqual([]);
      expect(await s.getMany("tenant-b", ["p1"])).toEqual([f("p1", "$9")]); // other tenant untouched
    });

    it("deleteTenant erases ALL of a tenant's facts (right-to-erasure)", async () => {
      const s = await makeAdapter();
      await s.upsertMany("tenant-a", [f("p1", "$1"), f("p2", "$2")]);
      await s.upsertMany("tenant-b", [f("p1", "$9")]);
      await s.deleteTenant("tenant-a");
      expect(await s.getMany("tenant-a", ["p1", "p2"])).toEqual([]);
      expect(await s.getMany("tenant-b", ["p1"])).toEqual([f("p1", "$9")]); // other tenant untouched
    });

    it("round-trips updatedAt to the SAME instant (adapters may normalize the string)", async () => {
      const s = await makeAdapter();
      const at = "2026-08-07T12:00:00.000Z";
      await s.upsertMany("t", [f("p1", "$1", { updatedAt: at })]);
      const [got] = await s.getMany("t", ["p1"]);
      expect(got?.updatedAt).toBeDefined();
      expect(new Date(got!.updatedAt!).getTime()).toBe(new Date(at).getTime());
    });

    it("rejects a blank tenantId on every op (fail-closed tenant isolation)", async () => {
      const s = await makeAdapter();
      await expect(s.getMany("", ["p1"])).rejects.toThrow(/tenant/i);
      await expect(s.upsertMany("  ", [f("p1", "$1")])).rejects.toThrow(/tenant/i);
      await expect(s.deleteMany("", ["p1"])).rejects.toThrow(/tenant/i);
      await expect(s.deleteTenant("")).rejects.toThrow(/tenant/i);
    });
  });
}
