import { describe, it, expect } from "vitest";
import { mapShopifyRole } from "../src/role-map.js";

describe("mapShopifyRole (ADR-0011 §4: PalUp's role, mapped from Shopify, editable in PalUp)", () => {
  it("Shopify store owner bootstraps to PalUp 'owner'", () => {
    expect(mapShopifyRole({ associatedUser: { id: "1", accountOwner: true, collaborator: false } })).toBe("owner");
  });
  it("a non-owner staff/collaborator bootstraps to least-privilege 'operator' (spec W7)", () => {
    expect(mapShopifyRole({ associatedUser: { id: "2", accountOwner: false, collaborator: true } })).toBe("operator");
    expect(mapShopifyRole({ associatedUser: { id: "3", accountOwner: false, collaborator: false } })).toBe("operator");
  });
  it("no associated_user (offline token) also defaults to least-privilege, never owner", () => {
    expect(mapShopifyRole({})).toBe("operator");
  });
  it("a PalUp-side override WINS over the Shopify bootstrap (editable in PalUp with audit)", () => {
    expect(mapShopifyRole({ associatedUser: { id: "1", accountOwner: true, collaborator: false }, override: "viewer" }))
      .toBe("viewer");
    expect(mapShopifyRole({ associatedUser: { id: "2", accountOwner: false, collaborator: false }, override: "admin" }))
      .toBe("admin");
  });
});
