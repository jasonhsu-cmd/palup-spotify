import { describe, it, expect } from "vitest";
import type { SecretsPort } from "../secrets-port.js";

// Every SecretsPort adapter must pass this (ADR-0001). `make()` MUST return an adapter seeded with
// tenant "t1" holding secret "k"="v1", and tenant "t2" holding NO "k" — so the contract can prove
// tenant isolation.
export function runSecretsPortContract(make: () => SecretsPort): void {
  describe("SecretsPort contract", () => {
    it("returns a set secret and undefined for a missing name", async () => {
      const s = make();
      expect(await s.get("t1", "k")).toBe("v1");
      expect(await s.get("t1", "not-set")).toBeUndefined();
    });

    it("is tenant-scoped — a tenant cannot read another tenant's secret", async () => {
      const s = make();
      expect(await s.get("t2", "k")).toBeUndefined(); // t2 has no "k" even though t1 does
    });

    it("returns undefined for a blank tenant or name (never a cross-key hit)", async () => {
      const s = make();
      expect(await s.get("", "k")).toBeUndefined();
      expect(await s.get("t1", "")).toBeUndefined();
    });
  });
}
