import { describe, it, expect } from "vitest";
import type { MerchantIdentityPort, MerchantPrincipal } from "../merchant-identity-port.js";

// Every MerchantIdentityPort adapter (embedded now; SSO/standalone later) must pass this — the ADR-0011
// "contract test covering both adapters". It asserts the PLANE-INVARIANTS the PDP depends on, regardless
// of HOW the adapter authenticated: default-deny, tenant-scoping is present, `can_approve_money` gates
// money, and no principal escapes its granted permission set.
export function runMerchantIdentityPortContract(
  port: MerchantIdentityPort,
  ownerPrincipal: MerchantPrincipal,     // a fully-authenticated owner from this adapter
  operatorPrincipal: MerchantPrincipal,  // a least-privilege operator from this adapter
): void {
  describe("MerchantIdentityPort contract", () => {
    it("authenticate returns anonymous for an absent credential and NEVER throws", async () => {
      const p = await port.authenticate(undefined);
      expect(p.kind).toBe("anonymous");
    });
    it("default-deny: an anonymous principal is authorized for NOTHING", async () => {
      const anon = await port.authenticate(undefined);
      for (const perm of ["console.view", "agent.operate", "approve_money", "billing.manage"] as const) {
        expect(port.authorize(anon, perm)).toBe(false);
      }
    });
    it("owner may approve money; operator may not (can_approve_money gate)", () => {
      expect(port.authorize(ownerPrincipal, "approve_money")).toBe(true);
      expect(port.authorize(operatorPrincipal, "approve_money")).toBe(false);
    });
    it("operator is view+operate only — no rules/settings/team/billing (no escalation)", () => {
      expect(port.authorize(operatorPrincipal, "console.view")).toBe(true);
      expect(port.authorize(operatorPrincipal, "agent.operate")).toBe(true);
      for (const perm of ["rules.edit", "settings.edit", "team.manage", "billing.manage"] as const) {
        expect(port.authorize(operatorPrincipal, perm)).toBe(false);
      }
    });
    it("every authenticated principal carries a non-empty tenant + user (tenant-scoping present)", () => {
      for (const p of [ownerPrincipal, operatorPrincipal]) {
        expect(p.merchantId).toBeTruthy();
        expect(p.userId).toContain(p.merchantId); // userId is namespaced by tenant
      }
    });
  });
}
