// Map a Shopify staff identity → a PalUp merchant role (ADR-0011 §4). PalUp NEVER inherits Shopify
// permissions wholesale: the bootstrap is deliberately conservative — the store OWNER seeds to `owner`,
// EVERYONE else (staff, collaborator, or an offline token with no associated_user) seeds to the
// least-privilege `operator` (spec W7), and the merchant elevates from there in W7. A stored per-tenant
// override (the W7 team table, injected via RoleOverrideSource) always WINS — that is the "editable in
// PalUp with audit" half of Decision 4.
import type { MerchantRole } from "@palup/platform-ports";
import type { AssociatedUser } from "./token-exchange.js";

export interface RoleOverrideSource {
  lookup(merchantId: string, userId: string): Promise<MerchantRole | undefined>;
}

export function mapShopifyRole(args: { associatedUser?: AssociatedUser; override?: MerchantRole }): MerchantRole {
  if (args.override) return args.override;                       // PalUp-side assignment wins
  if (args.associatedUser?.accountOwner === true) return "owner";
  return "operator";                                            // least-privilege default (never owner)
}
