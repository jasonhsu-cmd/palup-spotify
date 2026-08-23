import { describe, it, expect, vi } from "vitest";
import { createShopifyAppBridgeIdentity } from "../src/identity.js";
import { createInMemoryJtiGuard } from "../src/jti-guard.js";
import { can } from "@palup/platform-ports";
import {
  CLIENT_ID, secrets, acme, registryWith, multiTenantRegistry, sessionToken, exchangeOk,
} from "./_harness.js";

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

  it("ADVERSARIAL — tenant is resolved from the VERIFIED dest claim, not any other value: two shops, two tenants, and the registry is called with exactly the verified destHost", async () => {
    const { registry, lookupSpy } = multiTenantRegistry();
    const id = deps({ registry, fetchFn: exchangeOk(true) });

    const tokA = sessionToken({ iss: "https://shop-a.myshopify.com/admin", dest: "https://shop-a.myshopify.com", jti: "jti-a" });
    const rA = await id.establishSession(tokA);
    expect(rA.ok).toBe(true);
    if (rA.ok) expect(rA.principal.merchantId).toBe("tenant-A");
    expect(lookupSpy).toHaveBeenLastCalledWith("shop-a.myshopify.com");

    const tokB = sessionToken({ iss: "https://shop-b.myshopify.com/admin", dest: "https://shop-b.myshopify.com", jti: "jti-b" });
    const rB = await id.establishSession(tokB);
    expect(rB.ok).toBe(true);
    if (rB.ok) expect(rB.principal.merchantId).toBe("tenant-B");
    expect(lookupSpy).toHaveBeenLastCalledWith("shop-b.myshopify.com");

    expect(lookupSpy).toHaveBeenCalledTimes(2);
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
