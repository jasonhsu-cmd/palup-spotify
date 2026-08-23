import { describe, it, expect } from "vitest";
import {
  can, canApproveMoney, DEFAULT_ROLE_PERMISSIONS,
  type MerchantPrincipal, type MerchantRole,
} from "../src/merchant-identity-port.js";

const P = (role: MerchantRole): MerchantPrincipal => ({
  kind: "merchant_user", merchantId: "acme", userId: "shopify:acme:1",
  role, authLevel: "session", sessionId: "sid1",
});

describe("merchant RBAC model", () => {
  it("owner + admin approve money; manager/operator/viewer do NOT (least-privilege default, spec W1/W7)", () => {
    expect(canApproveMoney(P("owner"))).toBe(true);
    expect(canApproveMoney(P("admin"))).toBe(true);
    expect(canApproveMoney(P("manager"))).toBe(false);
    expect(canApproveMoney(P("operator"))).toBe(false);
    expect(canApproveMoney(P("viewer"))).toBe(false);
  });

  it("invited-teammate default (operator) = view + operate, nothing else (spec W7)", () => {
    expect(can(P("operator"), "console.view")).toBe(true);
    expect(can(P("operator"), "agent.operate")).toBe(true);
    expect(can(P("operator"), "rules.edit")).toBe(false);
    expect(can(P("operator"), "approve_money")).toBe(false);
    expect(can(P("operator"), "settings.edit")).toBe(false);
  });

  it("viewer is read-only; manager can edit rules+learned but not money/team/billing", () => {
    expect(can(P("viewer"), "console.view")).toBe(true);
    expect(can(P("viewer"), "agent.operate")).toBe(false);
    expect(can(P("manager"), "rules.edit")).toBe(true);
    expect(can(P("manager"), "learned.edit")).toBe(true);
    expect(can(P("manager"), "team.manage")).toBe(false);
    expect(can(P("manager"), "billing.manage")).toBe(false);
  });

  it("only owner manages billing (plan/cap → Shopify, W6)", () => {
    expect(can(P("owner"), "billing.manage")).toBe(true);
    expect(can(P("admin"), "billing.manage")).toBe(false);
  });

  it("default-deny for anonymous — every permission is false", () => {
    const anon = { kind: "anonymous" } as const;
    for (const perm of ["console.view", "agent.operate", "approve_money", "billing.manage"] as const) {
      expect(can(anon, perm)).toBe(false);
    }
    expect(canApproveMoney(anon)).toBe(false);
  });

  it("permission sets are monotonic up the role ladder (no privilege inversion)", () => {
    const ladder: MerchantRole[] = ["viewer", "operator", "manager", "admin", "owner"];
    for (let i = 1; i < ladder.length; i++) {
      const lower = new Set(DEFAULT_ROLE_PERMISSIONS[ladder[i - 1]]);
      const higher = new Set(DEFAULT_ROLE_PERMISSIONS[ladder[i]]);
      for (const p of lower) expect(higher.has(p)).toBe(true);
    }
  });
});
