import { describe, it, expect } from "vitest";
import type { SecretsPort } from "../secrets-port.js";

// Every SecretsPort adapter must pass this (ADR-0001). `make()` MUST return an adapter seeded with
// tenant "t1" holding secret "k"="v1", and tenant "t2" holding "k2"="v2" (and NO "k") — so the contract
// can prove BOTH that each tenant reads its OWN distinct secret and that neither can read the other's.
export function runSecretsPortContract(make: () => SecretsPort): void {
  describe("SecretsPort contract", () => {
    it("returns a set secret and undefined for a missing name", async () => {
      const s = make();
      expect(await s.get("t1", "k")).toBe("v1");
      expect(await s.get("t1", "not-set")).toBeUndefined();
    });

    it("is tenant-scoped — each tenant reads its own secret, never another's (both directions)", async () => {
      const s = make();
      expect(await s.get("t2", "k2")).toBe("v2"); // t2 reads its OWN secret (store isn't globally shared)
      expect(await s.get("t2", "k")).toBeUndefined(); // t2 cannot read t1's "k"
      expect(await s.get("t1", "k2")).toBeUndefined(); // t1 cannot read t2's "k2"
    });

    it("returns undefined for a blank tenant or name (never a cross-key hit)", async () => {
      const s = make();
      expect(await s.get("", "k")).toBeUndefined();
      expect(await s.get("t1", "")).toBeUndefined();
    });
  });
}
