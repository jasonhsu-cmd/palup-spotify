import { describe, it, expect } from "vitest";
import { mintShopperToken, createShopperTokenIdentity } from "../src/shopper-token-identity.js";
import { mintWidgetToken, createWidgetTokenIdentity } from "../src/widget-token-identity.js";

const SECRET = "shopper-signing-secret";

describe("shopper token identity (T3, mirrors widget-token-identity)", () => {
  it("mints + verifies a token → shopper principal, round-trip", async () => {
    const id = createShopperTokenIdentity(SECRET);
    const token = mintShopperToken(SECRET, "shopify:acme:123", "shopify", 300);
    expect(await id.authenticate(token)).toEqual({ kind: "shopper", shopperId: "shopify:acme:123", source: "shopify", verified: true });
  });

  it("authorizes account:*/shopper:self:* for a shopper, denies merchant/widget/operator", async () => {
    const id = createShopperTokenIdentity(SECRET);
    const p = await id.authenticate(mintShopperToken(SECRET, "shopify:acme:123", "shopify", 300));
    expect(id.authorize(p, "account:read")).toBe(true);
    expect(id.authorize(p, "shopper:self:view_order")).toBe(true);
    expect(id.authorize(p, "merchant:config")).toBe(false);
    expect(id.authorize(p, "widget:token")).toBe(false);
    expect(id.authorize(p, "operator:kill")).toBe(false);
  });

  it("rejects a tampered signature, a wrong-secret token, and garbage as anonymous (constant-time compare)", async () => {
    const id = createShopperTokenIdentity(SECRET);
    const good = mintShopperToken(SECRET, "shopify:acme:123", "shopify", 300);
    expect((await id.authenticate(good.slice(0, -2) + "xx")).kind).toBe("anonymous");
    expect((await id.authenticate(mintShopperToken("other-secret", "shopify:acme:123", "shopify", 300))).kind).toBe("anonymous");
    for (const junk of [undefined, "", "nodot", "a.b.c"]) {
      expect((await id.authenticate(junk as string | undefined)).kind).toBe("anonymous");
    }
  });

  it("rejects an expired token", async () => {
    const id = createShopperTokenIdentity(SECRET);
    const expired = mintShopperToken(SECRET, "shopify:acme:123", "shopify", -10);
    expect((await id.authenticate(expired)).kind).toBe("anonymous");
  });

  it("FAILS CLOSED with no signing secret configured", async () => {
    const id = createShopperTokenIdentity(undefined);
    expect((await id.authenticate(mintShopperToken(SECRET, "shopify:acme:123", "shopify", 300))).kind).toBe("anonymous");
  });

  // F1 — token-type separation: the two token types must never cross-verify, even under the SAME secret.
  describe("F1 token-type separation", () => {
    const SHARED_SECRET = "shared-secret-for-cross-check";

    it("a shopper token fed to the WIDGET/merchant verifier → anonymous, never merchant", async () => {
      const shopperToken = mintShopperToken(SHARED_SECRET, "shopify:acme:123", "shopify", 300);
      const widgetIdentity = createWidgetTokenIdentity(SHARED_SECRET);
      const p = await widgetIdentity.authenticate(shopperToken);
      expect(p.kind).toBe("anonymous");
      expect(p.kind).not.toBe("merchant");
    });

    it("a widget/merchant token fed to the SHOPPER verifier → anonymous, never shopper", async () => {
      const widgetToken = mintWidgetToken(SHARED_SECRET, "acme", 300);
      const shopperIdentity = createShopperTokenIdentity(SHARED_SECRET);
      const p = await shopperIdentity.authenticate(widgetToken);
      expect(p.kind).toBe("anonymous");
      expect(p.kind).not.toBe("shopper");
    });
  });
});
