import type { FastifyInstance } from "fastify";
import { requirePermission } from "@palup/identity-shopify";
import type { PayoutsPort, RuntimeStatePort } from "@palup/platform-ports";
import { readPaymentsView } from "../payments/read-model.js";

// W5 Task 6 — `GET /payments`: read-through of Shopify payouts (system of record) + the transparent,
// computed-not-charged PalUp fee line (Task 5's readPaymentsView). READ-ONLY; every money action
// stays in Shopify. The trust anchor: "PalUp never touches your money." `fee.chargeable` is always
// `false` on this response (enforced by computeFeeLine's return type in platform-ports) — never
// present it as a real charge; real billing is W6/deferred and this line is illustrative only.

export interface PaymentsRoutesDeps {
  payouts: PayoutsPort;
  state: RuntimeStatePort;
}

export function registerPaymentsRoutes(app: FastifyInstance, deps: PaymentsRoutesDeps): void {
  app.get("/payments", { preHandler: requirePermission("console.view") }, async (req) => {
    const principal = req.principal!; // set by the enclosing requireMerchant preHandler
    return readPaymentsView(deps.payouts, deps.state, principal.merchantId);
  });
}
