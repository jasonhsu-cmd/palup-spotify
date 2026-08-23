import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyShopifySessionToken } from "../src/session-token.js";

const SECRET = "app-client-secret";
const CLIENT_ID = "client-id-123";
const b64url = (o: unknown) =>
  Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sign = (body: string) =>
  createHmac("sha256", SECRET).update(body).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function tokenWith(overrides: Record<string, unknown> = {}, secret = SECRET): string {
  const header = b64url({ alg: "HS256", typ: "JWT" });
  const claims = {
    iss: "https://acme.myshopify.com/admin", dest: "https://acme.myshopify.com",
    aud: CLIENT_ID, sub: "42", exp: 2000, nbf: 500, iat: 500,
    jti: "f8912129-1af6-4cad-9ca3-76b0f7621087", sid: "sess-abc", ...overrides,
  };
  const body = `${header}.${b64url(claims)}`;
  const sig = createHmac("sha256", secret).update(body).digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${body}.${sig}`;
}
const base = { clientSecret: SECRET, clientId: CLIENT_ID, nowSec: 1000 };

describe("verifyShopifySessionToken", () => {
  it("accepts a valid token and parses the shop domain from dest", () => {
    const r = verifyShopifySessionToken({ token: tokenWith(), ...base });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.shopDomain).toBe("acme.myshopify.com"); expect(r.claims.sub).toBe("42"); }
  });
  it("rejects a tampered signature", () => {
    const good = tokenWith();
    const tampered = good.slice(0, -2) + (good.endsWith("aa") ? "bb" : "aa");
    expect(verifyShopifySessionToken({ token: tampered, ...base }).ok).toBe(false);
  });
  it("rejects a token signed with the wrong secret", () => {
    expect(verifyShopifySessionToken({ token: tokenWith({}, "wrong"), ...base }).ok).toBe(false);
  });
  it("rejects an expired token (exp in the past)", () => {
    expect(verifyShopifySessionToken({ token: tokenWith({ exp: 900 }), ...base }).ok).toBe(false);
  });
  it("rejects a not-yet-valid token (nbf in the future)", () => {
    expect(verifyShopifySessionToken({ token: tokenWith({ nbf: 1500 }), ...base }).ok).toBe(false);
  });
  it("rejects a wrong audience (token minted for another app)", () => {
    expect(verifyShopifySessionToken({ token: tokenWith({ aud: "other-app" }), ...base }).ok).toBe(false);
  });
  it("rejects when iss and dest hosts disagree (cross-shop stitching)", () => {
    const r = verifyShopifySessionToken({ token: tokenWith({ iss: "https://evil.myshopify.com/admin" }), ...base });
    expect(r.ok).toBe(false);
  });
  it("rejects a non-*.myshopify.com dest host", () => {
    const r = verifyShopifySessionToken({
      token: tokenWith({ iss: "https://acme.evil.test/admin", dest: "https://acme.evil.test" }), ...base });
    expect(r.ok).toBe(false);
  });
  it("fails closed on missing token / unconfigured secret / malformed JWT", () => {
    expect(verifyShopifySessionToken({ token: undefined, ...base }).ok).toBe(false);
    expect(verifyShopifySessionToken({ token: tokenWith(), clientSecret: undefined, clientId: CLIENT_ID, nowSec: 1000 }).ok).toBe(false);
    expect(verifyShopifySessionToken({ token: "not.a.jwt.at.all", ...base }).ok).toBe(false);
    expect(verifyShopifySessionToken({ token: "onlyonesegment", ...base }).ok).toBe(false);
  });
});
