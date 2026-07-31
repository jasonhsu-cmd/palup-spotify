import { describe, it, expect } from "vitest";
import { authorize } from "../src/identity-port.js";
import type { Principal } from "../src/identity-port.js";

// ADR-0017 T1: Principal + the port-level default-deny `authorize`. A verified shopper may perform
// `account:*` / `shopper:self:*` (WHICH record is enforced downstream in support.ts, not here);
// anonymous is always denied; a shopper may never reach merchant/widget/operator scope (no escalation).

const verifiedShopper: Principal = { kind: "shopper", shopperId: "shopify:acme:123", source: "shopify", verified: true };

describe("authorize (T1, default-deny)", () => {
  it("a verified shopper may act on its own account", () => {
    expect(authorize(verifiedShopper, "account:read")).toBe(true);
    expect(authorize(verifiedShopper, "shopper:self:view_order")).toBe(true);
  });

  it("anonymous is always denied", () => {
    expect(authorize({ kind: "anonymous" }, "account:read")).toBe(false);
    expect(authorize({ kind: "anonymous" }, "shopper:self:view_order")).toBe(false);
  });

  it("a shopper can never reach merchant/widget/operator scope (no escalation)", () => {
    expect(authorize(verifiedShopper, "merchant:config")).toBe(false);
    expect(authorize(verifiedShopper, "widget:token")).toBe(false);
    expect(authorize(verifiedShopper, "operator:kill")).toBe(false);
  });

  it("a merchant may perform shopper/widget actions but never operator actions", () => {
    const merchant: Principal = { kind: "merchant", merchantId: "acme" };
    expect(authorize(merchant, "shopper:chat")).toBe(true);
    expect(authorize(merchant, "widget:token")).toBe(true);
    expect(authorize(merchant, "operator:kill")).toBe(false);
    expect(authorize(merchant, "account:read")).toBe(false); // merchant is not a shopper
  });

  it("an operator may perform operator actions only", () => {
    const operator: Principal = { kind: "operator", operatorId: "op1" };
    expect(authorize(operator, "operator:kill")).toBe(true);
    expect(authorize(operator, "account:read")).toBe(false);
  });
});
