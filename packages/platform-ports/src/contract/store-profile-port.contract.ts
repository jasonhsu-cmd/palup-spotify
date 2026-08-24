import { describe, it, expect } from "vitest";
import type { StoreProfilePort, StoreProfileRecord } from "../store-profile-port.js";

// Port contract (ADR-0001; credential-enrollment-unification Task 2): every StoreProfilePort adapter
// (in-memory, Postgres, …) MUST pass this, so adapters stay behavior-equivalent and the engine stays
// swappable. `makeAdapter` returns a FRESH, empty adapter each call — async so a Postgres adapter can
// migrate/connect per test.
export function runStoreProfilePortContract(makeAdapter: () => StoreProfilePort | Promise<StoreProfilePort>): void {
  describe("StoreProfilePort contract", () => {
    const profile = (overrides: Partial<StoreProfileRecord> = {}): StoreProfileRecord => ({
      brandName: "Acme Skincare",
      policy: { returns: "30-day returns", shipping: "Ships in 2-3 days" },
      ...overrides,
    });

    it("get on a tenant with no profile returns null", async () => {
      const s = await makeAdapter();
      expect(await s.get("t")).toBeNull();
    });

    it("put + get round-trips the full record, including the optional allergens field", async () => {
      const s = await makeAdapter();
      const p = profile({ policy: { returns: "30-day returns", shipping: "Ships in 2-3 days", allergens: "Contains tree nuts" } });
      await s.put("t", p);
      expect(await s.get("t")).toEqual(p);
    });

    it("put + get round-trips a record WITHOUT allergens (optional field omitted)", async () => {
      const s = await makeAdapter();
      const p = profile();
      await s.put("t", p);
      const got = await s.get("t");
      expect(got).toEqual(p);
      expect(got?.policy.allergens).toBeUndefined();
    });

    it("put overwrites an existing tenant's profile (upsert — one row per tenant)", async () => {
      const s = await makeAdapter();
      await s.put("t", profile({ brandName: "Old Name" }));
      await s.put("t", profile({ brandName: "New Name" }));
      expect(await s.get("t")).toEqual(profile({ brandName: "New Name" }));
    });

    it("is tenant-isolated — one tenant never sees another's profile", async () => {
      const s = await makeAdapter();
      await s.put("tenant-a", profile({ brandName: "A Brand" }));
      await s.put("tenant-b", profile({ brandName: "B Brand" }));
      expect(await s.get("tenant-a")).toEqual(profile({ brandName: "A Brand" }));
      expect(await s.get("tenant-b")).toEqual(profile({ brandName: "B Brand" }));
      expect(await s.get("tenant-c")).toBeNull();
    });

    it("deleteTenant erases the tenant's profile (right-to-erasure)", async () => {
      const s = await makeAdapter();
      await s.put("tenant-a", profile());
      await s.put("tenant-b", profile({ brandName: "B Brand" }));
      await s.deleteTenant("tenant-a");
      expect(await s.get("tenant-a")).toBeNull();
      expect(await s.get("tenant-b")).toEqual(profile({ brandName: "B Brand" })); // other tenant untouched
    });

    it("deleteTenant on a tenant with no profile is a no-op", async () => {
      const s = await makeAdapter();
      await expect(s.deleteTenant("no-such-tenant")).resolves.toBeUndefined();
    });

    it("rejects a blank tenantId on every op (fail-closed tenant isolation)", async () => {
      const s = await makeAdapter();
      await expect(s.get("")).rejects.toThrow(/tenant/i);
      await expect(s.put("  ", profile())).rejects.toThrow(/tenant/i);
      await expect(s.deleteTenant("")).rejects.toThrow(/tenant/i);
    });
  });
}
