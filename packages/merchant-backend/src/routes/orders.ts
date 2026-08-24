import type { FastifyInstance } from "fastify";
import { requirePermission } from "@palup/identity-shopify";
import type { MerchantOrderSummary, OrderListingCommerce, RuntimeStatePort } from "@palup/platform-ports";
import { buildOrderTouchpoints, type OrderTouchpoint } from "../orders/touchpoints.js";
import { shopifyOrderAdminPath } from "../shopify-links.js";

// W5 — `GET /orders`: read-through of the tenant's Shopify orders (system of record), annotated with
// per-order agent touchpoints (Task 2, audit-backed). READ-ONLY: no order/fulfilment mutation ever
// happens here — money actions surface as the `adminPath` Shopify deep-link. NEVER shows incremental
// $ (that is aggregate/billed, W2/W6) — only factual per-order data. Honest by construction: when the
// adapter cannot enumerate orders (no live Admin-API adapter enabled), `source: "unavailable"` + an
// empty list, never a fabricated row.

const AUDIT_OVERFETCH = 500; // same bounded most-recent window as routes/activity.ts

export interface OrderView extends MerchantOrderSummary {
  touchpoints: OrderTouchpoint[];
  /** Shopify admin deep-link (relative) — where the merchant manages/refunds this order. */
  adminPath: string;
}

export interface OrdersRoutesDeps {
  orderCommerce: OrderListingCommerce;
  state: RuntimeStatePort;
}

export function registerOrdersRoutes(app: FastifyInstance, deps: OrdersRoutesDeps): void {
  app.get("/orders", { preHandler: requirePermission("console.view") }, async (req) => {
    const principal = req.principal!; // set by the enclosing requireMerchant preHandler
    const ctx = { tenantId: principal.merchantId };

    if (typeof deps.orderCommerce.listOrders !== "function") {
      return {
        items: [] as OrderView[],
        source: "unavailable" as const,
        sourceNote: "Order read-through is not connected yet — orders will appear once your Shopify orders scope is enabled.",
      };
    }

    const [orders, records] = await Promise.all([
      deps.orderCommerce.listOrders(ctx),
      deps.state.readAudit(ctx, { limit: AUDIT_OVERFETCH }),
    ]);
    const touchpointsByOrder = buildOrderTouchpoints(records);

    const items: OrderView[] = orders.map((o) => ({
      ...o,
      touchpoints: touchpointsByOrder.get(o.id) ?? [],
      adminPath: shopifyOrderAdminPath(o.id),
    }));

    return {
      items,
      source: "live" as const,
      sourceNote: "Shopify is the system of record. PalUp shows what your agent did — refunds and edits happen in Shopify.",
    };
  });
}
