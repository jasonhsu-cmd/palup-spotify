import type { preHandlerHookHandler } from "fastify";
import { can, type MerchantIdentityPort, type MerchantPrincipal, type Permission } from "@palup/platform-ports";

// The PDP mount point (IAM §2: authorization decided server-side, at one place, default-deny). Every
// merchant-plane route runs `requireMerchant` (→ request.principal) and declares the permission it needs
// via `requirePermission`. Bearer scheme carries the PalUp session token (Task 6). 401 = not
// authenticated; 403 = authenticated but not permitted.

declare module "fastify" {
  interface FastifyRequest { principal?: MerchantPrincipal; }
}

function bearer(req: { headers: Record<string, unknown> }): string | undefined {
  const h = req.headers["authorization"];
  if (typeof h !== "string") return undefined;
  const m = /^Bearer (.+)$/i.exec(h.trim());
  return m?.[1];
}

export function requireMerchant(port: MerchantIdentityPort): preHandlerHookHandler {
  return async (req, reply) => {
    const p = await port.authenticate(bearer(req));
    if (p.kind !== "merchant_user") { await reply.code(401).send({ error: "unauthenticated" }); return; }
    req.principal = p;
  };
}

export function requirePermission(permission: Permission): preHandlerHookHandler {
  return async (req, reply) => {
    // authenticate first if a route mounts this standalone (idempotent with requireMerchant above)
    const p = req.principal;
    if (!p || p.kind !== "merchant_user") { await reply.code(401).send({ error: "unauthenticated" }); return; }
    if (!can(p, permission)) { await reply.code(403).send({ error: "forbidden", permission }); return; }
  };
}

const SHOP_HOST = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;
/** CSP `frame-ancestors` pinning the embedded console to Shopify admin (+ the shop). A non-myshopify
 *  host is NEVER reflected — it degrades to admin-only rather than widening the frame to an attacker. */
export function shopifyEmbedFrameAncestors(shopDomain: string): string {
  const base = "frame-ancestors https://admin.shopify.com";
  return SHOP_HOST.test(shopDomain) ? `${base} https://${shopDomain.toLowerCase()}` : base;
}
