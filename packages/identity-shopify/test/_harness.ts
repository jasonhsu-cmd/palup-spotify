// Shared test harness for the Shopify App Bridge identity adapter — extracted out of identity.test.ts
// (T7) so both identity.test.ts and contract.test.ts (T8) build fixtures the same way instead of
// drifting into two slightly different notions of "a valid Shopify session token".
import { vi } from "vitest";
import { createHmac } from "node:crypto";
import type { SecretsPort, MerchantRegistryPort, MerchantRecord } from "@palup/platform-ports";

export const CLIENT_ID = "client-id-123";
export const APP_SECRET = "app-secret";
export const SESSION_SECRET = "palup-session-secret";
const SCOPE = "__shopify_app__";               // SHOPIFY_APP_SECRET_SCOPE
const APP_SECRET_NAME = "shopify_app_client_secret";
const SESSION_SECRET_NAME = "palup_merchant_session_secret";

export const secrets: SecretsPort = {
  async get(tenant, name) {
    if (tenant === SCOPE && name === APP_SECRET_NAME) return APP_SECRET;
    if (tenant === SCOPE && name === SESSION_SECRET_NAME) return SESSION_SECRET;
    return undefined;
  },
};
export const acme: MerchantRecord = {
  tenantId: "acme", shopDomain: "acme.myshopify.com", embedKey: "ek", status: "active",
  region: "us", groundingMode: "full", createdAt: "t", updatedAt: "t",
};
export function registryWith(rec: MerchantRecord | null): MerchantRegistryPort {
  return {
    lookupByShopDomain: async () => rec, lookupByTenantId: async () => rec, lookupByEmbedKey: async () => rec,
    create: async () => acme, setStatus: async () => acme, update: async () => acme,
  } as unknown as MerchantRegistryPort;
}
// Adversarial double for the tenant-isolation invariant: DIFFERENT records keyed by shop domain, plus a
// spy so the test can assert what `lookupByShopDomain` was actually called with — not just what it
// returns. A registry that ignores its argument (`registryWith` above) can never fail this invariant
// even if the implementation resolved the tenant from an unverified source.
export const shopA: MerchantRecord = {
  tenantId: "tenant-A", shopDomain: "shop-a.myshopify.com", embedKey: "ek-a", status: "active",
  region: "us", groundingMode: "full", createdAt: "t", updatedAt: "t",
};
export const shopB: MerchantRecord = {
  tenantId: "tenant-B", shopDomain: "shop-b.myshopify.com", embedKey: "ek-b", status: "active",
  region: "us", groundingMode: "full", createdAt: "t", updatedAt: "t",
};
export function multiTenantRegistry() {
  const byDomain: Record<string, MerchantRecord> = {
    "shop-a.myshopify.com": shopA, "shop-b.myshopify.com": shopB,
  };
  const lookupSpy = vi.fn(async (domain: string) => byDomain[domain] ?? null);
  const registry = {
    lookupByShopDomain: lookupSpy, lookupByTenantId: async () => null, lookupByEmbedKey: async () => null,
    create: async () => shopA, setStatus: async () => shopA, update: async () => shopA,
  } as unknown as MerchantRegistryPort;
  return { registry, lookupSpy };
}
export const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64")
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export function sessionToken(over: Record<string, unknown> = {}): string {
  const header = b64url({ alg: "HS256", typ: "JWT" });
  const body = `${header}.${b64url({ iss: "https://acme.myshopify.com/admin", dest: "https://acme.myshopify.com",
    aud: CLIENT_ID, sub: "42", exp: 2000, nbf: 500, iat: 500, jti: "jti-xyz", sid: "sess-abc", ...over })}`;
  const sig = createHmac("sha256", APP_SECRET).update(body).digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${body}.${sig}`;
}
export function exchangeOk(accountOwner: boolean) {
  return vi.fn(async () => ({ ok: true, json: async () => ({
    access_token: "at", scope: "read_orders",
    associated_user: { id: 42, account_owner: accountOwner, collaborator: false, email: "u@acme.test" },
  }) })) as unknown as typeof fetch;
}
