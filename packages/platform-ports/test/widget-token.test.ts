import { describe, it, expect } from "vitest";
import { mintWidgetToken, createWidgetTokenIdentity } from "../src/widget-token-identity.js";

const SECRET = "widget-signing-secret";

describe("widget token identity (tenant from verified claims)", () => {
  it("mints + verifies a token → merchant principal with the bound merchantId", async () => {
    const id = createWidgetTokenIdentity(SECRET);
    const token = mintWidgetToken(SECRET, "merchant-42", 300);
    expect(await id.authenticate(token)).toEqual({ kind: "merchant", merchantId: "merchant-42" });
  });

  it("authorizes shopper/widget actions for a merchant, denies operator actions (no escalation)", async () => {
    const id = createWidgetTokenIdentity(SECRET);
    const p = await id.authenticate(mintWidgetToken(SECRET, "m1", 300));
    expect(id.authorize(p, "shopper:chat")).toBe(true);
    expect(id.authorize(p, "widget:token")).toBe(true);
    expect(id.authorize(p, "operator:kill")).toBe(false); // a merchant can never do operator actions
  });

  it("rejects a tampered signature, a wrong-secret token, and garbage as anonymous", async () => {
    const id = createWidgetTokenIdentity(SECRET);
    const good = mintWidgetToken(SECRET, "m1", 300);
    expect((await id.authenticate(good.slice(0, -2) + "xx")).kind).toBe("anonymous"); // tampered sig
    expect((await id.authenticate(mintWidgetToken("other-secret", "m1", 300))).kind).toBe("anonymous");
    for (const junk of [undefined, "", "nodot", "a.b.c"]) {
      expect((await id.authenticate(junk as string | undefined)).kind).toBe("anonymous");
    }
  });

  it("rejects an expired token", async () => {
    const id = createWidgetTokenIdentity(SECRET);
    const expired = mintWidgetToken(SECRET, "m1", -10); // exp in the past
    expect((await id.authenticate(expired)).kind).toBe("anonymous");
  });

  it("FAILS CLOSED with no signing secret configured", async () => {
    const id = createWidgetTokenIdentity(undefined);
    expect((await id.authenticate(mintWidgetToken(SECRET, "m1", 300))).kind).toBe("anonymous");
  });

  it("a merchant cannot forge a different tenant — claims are signed", async () => {
    const id = createWidgetTokenIdentity(SECRET);
    // Take a valid token for m1, swap the body to claim m2 → signature no longer matches → anonymous.
    const t = mintWidgetToken(SECRET, "m1", 300);
    const forgedBody = Buffer.from(JSON.stringify({ m: "m2", exp: Math.floor(Date.now() / 1000) + 300 }))
      .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const forged = `${forgedBody}.${t.slice(t.indexOf(".") + 1)}`;
    expect((await id.authenticate(forged)).kind).toBe("anonymous");
  });
});
