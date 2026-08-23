import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { requireMerchant, requirePermission, shopifyEmbedFrameAncestors } from "../src/fastify-plugin.js";
import { mintMerchantSession } from "../src/palup-session.js";
import { verifyMerchantSession } from "../src/palup-session.js";
import type { MerchantIdentityPort } from "@palup/platform-ports";
import { can } from "@palup/platform-ports";

const SECRET = "s";
// a tiny port that authenticates our PalUp session tokens and authorizes via `can`
const port: MerchantIdentityPort = {
  async authenticate(c) { return verifyMerchantSession(SECRET, c, Math.floor(Date.now() / 1000)); },
  authorize(p, perm) { return can(p, perm); },
};
const ownerTok = mintMerchantSession(SECRET, { merchantId: "acme", userId: "shopify:acme:1", role: "owner", authLevel: "session", sid: "s1" }, 1800);
const operatorTok = mintMerchantSession(SECRET, { merchantId: "acme", userId: "shopify:acme:2", role: "operator", authLevel: "session", sid: "s2" }, 1800);

function app() {
  const f = Fastify();
  f.addHook("preHandler", requireMerchant(port));
  f.get("/home", async (req) => ({ merchantId: (req as any).principal.merchantId }));
  f.post("/approvals/:id/approve", { preHandler: requirePermission("approve_money") }, async () => ({ approved: true }));
  return f;
}

// `requirePermission` mounted WITHOUT `requireMerchant` ever running first (no app-wide hook here) —
// the standalone-mount case the code comment calls out. `request.principal` is never set, so this must
// fail closed (401), never crash and never silently pass a permission check with an undefined principal.
function standaloneApp() {
  const f = Fastify();
  f.post("/approvals/:id/approve", { preHandler: requirePermission("approve_money") }, async () => ({ approved: true }));
  return f;
}

describe("Fastify merchant auth preHandlers", () => {
  it("401 with no bearer token", async () => {
    const r = await app().inject({ method: "GET", url: "/home" });
    expect(r.statusCode).toBe(401);
  });
  it("200 + principal.merchantId for a valid session", async () => {
    const r = await app().inject({ method: "GET", url: "/home", headers: { authorization: `Bearer ${ownerTok}` } });
    expect(r.statusCode).toBe(200);
    expect(r.json().merchantId).toBe("acme");
  });
  it("owner may approve money (200); operator is forbidden (403)", async () => {
    const ok = await app().inject({ method: "POST", url: "/approvals/1/approve", headers: { authorization: `Bearer ${ownerTok}` } });
    expect(ok.statusCode).toBe(200);
    const no = await app().inject({ method: "POST", url: "/approvals/1/approve", headers: { authorization: `Bearer ${operatorTok}` } });
    expect(no.statusCode).toBe(403);
  });
  it("CSP frame-ancestors pins framing to Shopify admin + the shop (anti-clickjacking)", () => {
    const v = shopifyEmbedFrameAncestors("acme.myshopify.com");
    expect(v).toBe("frame-ancestors https://admin.shopify.com https://acme.myshopify.com");
  });
  it("CSP helper refuses a non-myshopify host (returns admin-only, never reflects a bad host)", () => {
    expect(shopifyEmbedFrameAncestors("evil.test")).toBe("frame-ancestors https://admin.shopify.com");
  });
  it("requirePermission mounted standalone (requireMerchant never ran, no request.principal) fails CLOSED with 401, not a crash or a pass", async () => {
    const r = await standaloneApp().inject({
      method: "POST", url: "/approvals/1/approve", headers: { authorization: `Bearer ${ownerTok}` },
    });
    expect(r.statusCode).toBe(401);
  });
});
