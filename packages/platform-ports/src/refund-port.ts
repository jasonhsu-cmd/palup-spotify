// Refund port (ADR-0001, ADR-0008): issues a refund on the merchant's commerce system. The ONLY money
// MUTATION in W5 — everything else is read-through. Building it dark is safe: the default adapter is
// the SandboxRefundAdapter, which RECORDS an intent and NEVER contacts a real payment gateway. A live
// Shopify refund adapter is a deferred, human + security-reviewer-gated enablement. This port is only
// ever reached through the W1 proposal loop (auto within PALUP_FLOORS.refund, or post human-approval).

export interface RefundRequest {
  orderRef: string;
  amountUsd: number;
  reason: string;
}

export interface RefundResult {
  ok: boolean;
  detail: string;
  /** The real, callable way back (or honest containment) — refunds are money, so this is required. */
  reversalPath: string;
}

export interface RefundPort {
  /** TRUE only for an adapter that moves real money. Absent/false ⇒ sandbox (records, never issues). */
  readonly isLive?: boolean;
  issueRefund(ctx: { tenantId: string }, req: RefundRequest): Promise<RefundResult>;
}

/** Records refund intents, NEVER issues real money — the dev/test/staging seam (mirrors
 *  SandboxCommsAdapter). The live Shopify refund adapter is a separate, human-gated step. */
export class SandboxRefundAdapter implements RefundPort {
  public readonly issued: Array<{ tenantId: string } & RefundRequest> = [];
  async issueRefund(ctx: { tenantId: string }, req: RefundRequest): Promise<RefundResult> {
    this.issued.push({ tenantId: ctx.tenantId, ...req });
    return {
      ok: true,
      detail: `sandbox refund recorded (NOT issued): $${req.amountUsd} on order ${req.orderRef}`,
      reversalPath: "Re-charge the customer via Shopify admin — this sandbox refund was never sent to a real gateway.",
    };
  }
}
