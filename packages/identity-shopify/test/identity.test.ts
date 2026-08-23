import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createShopifyAppBridgeIdentity } from "../src/identity.js";
import { createInMemoryJtiGuard } from "../src/jti-guard.js";
import { can } from "@palup/platform-ports";
import type { SecretsPort, MerchantRegistryPort, MerchantRecord } from "@palup/platform-ports";

const CLIENT_ID = "client-id-123";
const APP_SECRET = "app-secret";
const SESSION_SECRET = "palup-session-secret";
const SCOPE = "__shopify_app__";               // SHOPIFY_APP_SECRET_SCOPE
const APP_SECRET_NAME = "shopify_app_client_secret";
const SESSION_SECRET_NAME = "palup_merchant_session_secret";

const secrets: SecretsPort = {
  async get(tenant, name) {
    if (tenant === SCOPE && name === APP_SECRET_NAME) return APP_SECRET;
    if (tenant === SCOPE && name === SESSION_SECRET_NAME) return SESSION_SECRET;
    return undefined;
  },
};
const acme: MerchantRecord = {
  tenantId: "acme", shopDomain: "acme.myshopify.com", embedKey: "ek", status: "active",
  region: "us", groundingMode: "full", createdAt: "t", updatedAt: "t",
};
function registryWith(rec: MerchantRecord | null): MerchantRegistryPort {
  return {
    lookupByShopDomain: async () => rec, lookupByTenantId: async () => rec, lookupByEmbedKey: async () => rec,
    create: async () => acme, setStatus: async () => acme, update: async () => acme,
  } as unknown as MerchantRegistryPort;
}
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64")
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function sessionToken(over: Record<string, unknown> = {}): string {
  const header = b64url({ alg: "HS256", typ: "JWT" });
  const body = `${header}.${b64url({ iss: "https://acme.myshopify.com/admin", dest: "https://acme.myshopify.com",
    aud: CLIENT_ID, sub: "42", exp: 2000, nbf: 500, iat: 500, jti: "jti-xyz", sid: "sess-abc", ...over })}`;
  const sig = createHmac("sha256", APP_SECRET).update(body).digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${body}.${sig}`;
}
function exchangeOk(accountOwner: boolean) {
  return vi.fn(async () => ({ ok: true, json: async () => ({
    access_token: "at", scope: "read_orders",
    associated_user: { id: 42, account_owner: accountOwner, collaborator: false, email: "u@acme.test" },
  }) })) as unknown as typeof fetch;
}
const deps = (over: Partial<Parameters<typeof createShopifyAppBridgeIdentity>[0]> = {}) =>
  createShopifyAppBridgeIdentity({
    clientId: CLIENT_ID, secrets, registry: registryWith(acme), jtiGuard: createInMemoryJtiGuard(() => 1000),
    fetchFn: exchangeOk(true), nowSec: () => 1000, ...over,
  });

describe("createShopifyAppBridgeIdentity.establishSession", () => {
  it("validates → exchanges → binds tenant from dest → maps role → mints a session (owner)", async () => {
    const id = deps();
    const r = await id.establishSession(sessionToken());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.principal.merchantId).toBe("acme");            // from VERIFIED dest, resolved via registry
      expect(r.principal.userId).toBe("shopify:acme:42");     // namespaced sub
      expect(r.principal.role).toBe("owner");                 // account_owner ⇒ owner
      expect(r.principal.authLevel).toBe("session");
      expect(can(r.principal, "approve_money")).toBe(true);
      // the minted token verifies back through authenticate()
      const p2 = await id.authenticate(r.palupSessionToken);
      expect(p2.kind).toBe("merchant_user");
    }
  });

  it("TENANT COMES FROM CLAIMS, NOT INPUT: a non-owner staff bootstraps to least-privilege operator", async () => {
    const id = deps({ fetchFn: exchangeOk(false) });
    const r = await id.establishSession(sessionToken());
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.principal.role).toBe("operator"); expect(can(r.principal, "approve_money")).toBe(false); }
  });

  it("SINGLE-USE: the same session token cannot be exchanged twice (jti replay refused)", async () => {
    const id = deps();
    const tok = sessionToken();
    expect((await id.establishSession(tok)).ok).toBe(true);
    const second = await id.establishSession(tok);
    expect(second.ok).toBe(false);                            // replayed jti
  });

  it("fail-closed on a suspended/uninstalled merchant (registry returns null with default lookup)", async () => {
    const id = deps({ registry: registryWith(null) });
    expect((await id.establishSession(sessionToken())).ok).toBe(false);
  });

  it("rejects an invalid session token before any exchange (no fetch, no mint)", async () => {
    const spy = vi.fn(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
    const id = deps({ fetchFn: spy });
    const bad = sessionToken({ aud: "other-app" });
    expect((await id.establishSession(bad)).ok).toBe(false);
    expect(spy as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});

describe("createShopifyAppBridgeIdentity.authenticate / authorize (the port surface)", () => {
  it("anonymous for a missing/garbage credential; default-deny authorize", async () => {
    const id = deps();
    const p = await id.authenticate(undefined);
    expect(p.kind).toBe("anonymous");
    expect(id.authorize(p, "console.view")).toBe(false);
  });
  it("a fresh operator principal may view+operate but NOT approve money", async () => {
    const id = deps({ fetchFn: exchangeOk(false) });
    const r = await id.establishSession(sessionToken());
    if (r.ok) {
      expect(id.authorize(r.principal, "agent.operate")).toBe(true);
      expect(id.authorize(r.principal, "approve_money")).toBe(false);
    }
  });
});
