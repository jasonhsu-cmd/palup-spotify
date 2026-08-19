import { describe, it, expect } from "vitest";
import type { PresentmentPricePort, PresentmentPrice } from "../presentment-price-port.js";

// Port contract (ADR-0001; ADR-0020 B-T3): every PresentmentPricePort adapter (in-memory, Postgres, …)
// MUST pass this, so adapters stay behavior-equivalent and the engine stays swappable. `makeAdapter`
// returns a FRESH, empty adapter each call — async so a Postgres adapter can migrate/connect per test.
export function runPresentmentPricePortContract(makeAdapter: () => PresentmentPricePort | Promise<PresentmentPricePort>): void {
  describe("PresentmentPricePort contract", () => {
    const p = (productId: string, currency: string, price: string, extra: Partial<PresentmentPrice> = {}): PresentmentPrice => ({
      productId,
      currency,
      price,
      ...extra,
    });

    it("upsertMany + getMany hydrates exactly the requested ids IN the requested currency", async () => {
      const s = await makeAdapter();
      await s.upsertMany("tenant-a", [
        p("p1", "EUR", "€18", { source: "shopify:presentmentPrices" }),
        p("p2", "EUR", "€34"),
        p("p3", "EUR", "€26"),
      ]);
      const got = await s.getMany("tenant-a", ["p1", "p3"], "EUR");
      expect(got.map((x) => x.productId).sort()).toEqual(["p1", "p3"]);
      expect(got.find((x) => x.productId === "p1")).toEqual(p("p1", "EUR", "€18", { source: "shopify:presentmentPrices" }));
    });

    it("is CURRENCY-isolated — a query in one currency never returns another currency's price", async () => {
      const s = await makeAdapter();
      await s.upsertMany("t", [p("p1", "EUR", "€18"), p("p1", "JPY", "¥2800")]);
      expect(await s.getMany("t", ["p1"], "EUR")).toEqual([p("p1", "EUR", "€18")]);
      expect(await s.getMany("t", ["p1"], "JPY")).toEqual([p("p1", "JPY", "¥2800")]);
      expect(await s.getMany("t", ["p1"], "GBP")).toEqual([]); // no published GBP price ⇒ omitted, never invented
    });

    it("normalizes the currency code to upper-case on read and write", async () => {
      const s = await makeAdapter();
      await s.upsertMany("t", [p("p1", "eur", "€18")]);
      const got = await s.getMany("t", ["p1"], "eur");
      expect(got).toEqual([p("p1", "EUR", "€18")]);
    });

    it("omits ids with no published price (never invents / converts)", async () => {
      const s = await makeAdapter();
      await s.upsertMany("t", [p("p1", "EUR", "€1")]);
      expect((await s.getMany("t", ["p1", "does-not-exist"], "EUR")).map((x) => x.productId)).toEqual(["p1"]);
    });

    it("returns one row per DISTINCT id even if the request repeats an id", async () => {
      const s = await makeAdapter();
      await s.upsertMany("t", [p("p1", "EUR", "€1")]);
      expect((await s.getMany("t", ["p1", "p1", "p1"], "EUR")).map((x) => x.productId)).toEqual(["p1"]);
    });

    it("empty id list returns []", async () => {
      const s = await makeAdapter();
      await s.upsertMany("t", [p("p1", "EUR", "€1")]);
      expect(await s.getMany("t", [], "EUR")).toEqual([]);
    });

    it("upsertMany overwrites an existing (product, currency) price (fresh price wins)", async () => {
      const s = await makeAdapter();
      await s.upsertMany("t", [p("p1", "EUR", "€18")]);
      await s.upsertMany("t", [p("p1", "EUR", "€16")]);
      expect(await s.getMany("t", ["p1"], "EUR")).toEqual([p("p1", "EUR", "€16")]);
    });

    it("is tenant-isolated — one tenant never sees another's prices", async () => {
      const s = await makeAdapter();
      await s.upsertMany("tenant-a", [p("p1", "EUR", "€18")]);
      await s.upsertMany("tenant-b", [p("p1", "EUR", "€99")]);
      expect(await s.getMany("tenant-b", ["p1"], "EUR")).toEqual([p("p1", "EUR", "€99")]);
      expect(await s.getMany("tenant-c", ["p1"], "EUR")).toEqual([]);
    });

    it("deleteMany removes the named products across ALL currencies, leaving the rest (delist-prune)", async () => {
      const s = await makeAdapter();
      await s.upsertMany("t", [p("p1", "EUR", "€1"), p("p1", "JPY", "¥100"), p("p2", "EUR", "€2")]);
      await s.deleteMany("t", ["p1", "does-not-exist"]); // absent id ignored (idempotent)
      expect(await s.getMany("t", ["p1"], "EUR")).toEqual([]); // every currency of p1 gone
      expect(await s.getMany("t", ["p1"], "JPY")).toEqual([]);
      expect(await s.getMany("t", ["p2"], "EUR")).toEqual([p("p2", "EUR", "€2")]); // survivor untouched
    });

    it("deleteMany with an empty id list is a no-op", async () => {
      const s = await makeAdapter();
      await s.upsertMany("t", [p("p1", "EUR", "€1")]);
      await s.deleteMany("t", []);
      expect(await s.getMany("t", ["p1"], "EUR")).toEqual([p("p1", "EUR", "€1")]);
    });

    it("deleteMany is tenant-isolated — pruning one tenant never touches another's identically-keyed rows", async () => {
      const s = await makeAdapter();
      await s.upsertMany("tenant-a", [p("p1", "EUR", "€1")]);
      await s.upsertMany("tenant-b", [p("p1", "EUR", "€9")]);
      await s.deleteMany("tenant-a", ["p1"]);
      expect(await s.getMany("tenant-a", ["p1"], "EUR")).toEqual([]);
      expect(await s.getMany("tenant-b", ["p1"], "EUR")).toEqual([p("p1", "EUR", "€9")]); // other tenant untouched
    });

    it("deleteTenant erases ALL of a tenant's prices across currencies (right-to-erasure)", async () => {
      const s = await makeAdapter();
      await s.upsertMany("tenant-a", [p("p1", "EUR", "€1"), p("p1", "JPY", "¥100")]);
      await s.upsertMany("tenant-b", [p("p1", "EUR", "€9")]);
      await s.deleteTenant("tenant-a");
      expect(await s.getMany("tenant-a", ["p1"], "EUR")).toEqual([]);
      expect(await s.getMany("tenant-a", ["p1"], "JPY")).toEqual([]);
      expect(await s.getMany("tenant-b", ["p1"], "EUR")).toEqual([p("p1", "EUR", "€9")]); // other tenant untouched
    });

    it("round-trips updatedAt to the SAME instant (adapters may normalize the string)", async () => {
      const s = await makeAdapter();
      const at = "2026-08-08T12:00:00.000Z";
      await s.upsertMany("t", [p("p1", "EUR", "€1", { updatedAt: at })]);
      const [got] = await s.getMany("t", ["p1"], "EUR");
      expect(got?.updatedAt).toBeDefined();
      expect(new Date(got!.updatedAt!).getTime()).toBe(new Date(at).getTime());
    });

    it("rejects a blank tenantId or currency on the relevant ops (fail-closed isolation)", async () => {
      const s = await makeAdapter();
      await expect(s.getMany("", ["p1"], "EUR")).rejects.toThrow(/tenant/i);
      await expect(s.getMany("t", ["p1"], "  ")).rejects.toThrow(/currency/i);
      await expect(s.upsertMany("  ", [p("p1", "EUR", "€1")])).rejects.toThrow(/tenant/i);
      await expect(s.deleteMany("", ["p1"])).rejects.toThrow(/tenant/i);
      await expect(s.deleteTenant("")).rejects.toThrow(/tenant/i);
    });
  });
}
