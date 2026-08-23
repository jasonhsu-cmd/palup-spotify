// Merchant-console identity contract (ADR-0011 / IAM §8). DISTINCT from the storefront/operator
// `Principal` union in identity-port.ts: that `merchant` variant is a STOREFRONT TENANT (no user, no
// role); this is a console USER carrying a role + authLevel — the two planes must not be conflated
// (spec §4). Pure types + pure decision functions; ZERO Shopify knowledge (the adapter owns that).

export type MerchantRole = "viewer" | "operator" | "manager" | "admin" | "owner";
export type AuthLevel = "session" | "elevated";

export interface MerchantPrincipal {
  readonly kind: "merchant_user";
  readonly merchantId: string;
  readonly userId: string;
  readonly role: MerchantRole;
  readonly authLevel: AuthLevel;
  readonly sessionId: string;
}
export interface AnonymousPrincipal { readonly kind: "anonymous"; }
export type MerchantAuthResult = MerchantPrincipal | AnonymousPrincipal;

export type Permission =
  | "console.view" | "agent.operate" | "rules.edit" | "learned.edit"
  | "approve_money" | "team.manage" | "settings.edit" | "billing.manage";

// Least-privilege default (spec W7). `operator` is the invited-teammate default (view + operate, no
// money). `approve_money` is owner+admin only (spec W1/§10). Grants are additive up the ladder.
const VIEWER: readonly Permission[] = ["console.view"];
const OPERATOR: readonly Permission[] = [...VIEWER, "agent.operate"];
const MANAGER: readonly Permission[] = [...OPERATOR, "rules.edit", "learned.edit"];
const ADMIN: readonly Permission[] = [...MANAGER, "approve_money", "team.manage", "settings.edit"];
const OWNER: readonly Permission[] = [...ADMIN, "billing.manage"];

export const DEFAULT_ROLE_PERMISSIONS: Readonly<Record<MerchantRole, readonly Permission[]>> = {
  viewer: VIEWER, operator: OPERATOR, manager: MANAGER, admin: ADMIN, owner: OWNER,
};

export function can(principal: MerchantAuthResult, permission: Permission): boolean {
  if (principal.kind !== "merchant_user") return false; // default-deny: anonymous ⇒ false
  return DEFAULT_ROLE_PERMISSIONS[principal.role].includes(permission);
}
export function canApproveMoney(principal: MerchantAuthResult): boolean {
  return can(principal, "approve_money");
}

export interface MerchantIdentityPort {
  authenticate(credential: string | undefined): Promise<MerchantAuthResult>;
  authorize(principal: MerchantAuthResult, permission: Permission): boolean;
}
