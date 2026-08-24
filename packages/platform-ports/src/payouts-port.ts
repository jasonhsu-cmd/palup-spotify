// Payouts port (ADR-0001, ADR-0008): READ-ONLY read-through of the merchant's Shopify Payments
// payouts. PalUp never touches this money — payouts flow merchant<->Shopify; this port only READS
// them so the console can show them alongside a transparent, COMPUTED-NOT-CHARGED fee line. A real
// Shopify-Payments adapter (`read_shopify_payments_payouts` scope) is a later, human-gated
// staging-enablement step; feature code depends only on this interface.

export interface Payout {
  id: string;
  /** Shopify payout status: "paid" | "in_transit" | "scheduled" | "failed" | "cancelled". */
  status: string;
  amountUsd: number;
  currency: string;
  /** ISO-8601 date the payout was issued/scheduled. */
  issuedAt: string;
  /** Optional bank/last-4 reference for display. */
  bankReference?: string;
}

export interface PayoutsPort {
  listPayouts(ctx: { tenantId: string }, opts?: { limit?: number }): Promise<Payout[]>;
}

/** A non-blank tenantId is REQUIRED — an empty tenant is a cross-tenant wildcard (fail closed). */
export function requirePayoutsTenant(tenantId: string): string {
  if (!tenantId || !tenantId.trim()) throw new Error("PayoutsPort: a non-blank tenantId is required (tenant isolation)");
  return tenantId;
}

/** In-memory sandbox — seeded fixtures, never calls Shopify. Keyed by tenant (unseeded → empty). */
export class SandboxPayoutsPort implements PayoutsPort {
  constructor(private readonly payoutsByTenant: Readonly<Record<string, Payout[]>> = {}) {}
  async listPayouts(ctx: { tenantId: string }, opts?: { limit?: number }): Promise<Payout[]> {
    const all = (this.payoutsByTenant[requirePayoutsTenant(ctx.tenantId)] ?? []).map((p) => ({ ...p }));
    return typeof opts?.limit === "number" ? all.slice(0, opts.limit) : all;
  }
}

/**
 * The PalUp performance take-rate used to render the transparent fee LINE on the Payments screen.
 * ILLUSTRATIVE ONLY — this constant computes what the fee WOULD be so the merchant sees it plainly;
 * it is NEVER charged here. Actual billing (the real, separately-gated §3 fee model) is W6 / ADR-0007
 * and runs through Shopify Billing. ~6% on incremental per spec §10 (W6 decisions ledger).
 */
export const PALUP_ILLUSTRATIVE_TAKE_RATE = 0.06;

export interface FeeLine {
  /** ALWAYS false in W5 — this line is computed for transparency, never charged (billing is W6). */
  chargeable: false;
  ratePct: number;
  /** The incremental (holdout-proven) revenue the fee is computed on; null when not yet powered. */
  baseIncrementalUsd: number | null;
  computedFeeUsd: number | null;
  reason: "computed" | "attribution_underpowered";
}

/**
 * Computes the illustrative fee from the SINGLE canonical incremental source (the outcome ledger,
 * ADR-0007). When attribution is not yet powered, WITHHOLDS the number (null) with a reason — never a
 * fabricated fee. The fee rides on INCREMENTAL, never on payouts/GMV: the merchant keeps 100% of the
 * money they'd have made anyway, and 94% of the money PalUp created.
 *
 * PURE function: never moves money, never writes anything, never calls a network/DB. `chargeable` is
 * always `false` — this is illustrative only; real billing is a separate, later, human-gated W6 path.
 */
export function computeFeeLine(incrementalUsd: number, powered: boolean, rate: number = PALUP_ILLUSTRATIVE_TAKE_RATE): FeeLine {
  const ratePct = Math.round(rate * 100);
  if (!powered) {
    return { chargeable: false, ratePct, baseIncrementalUsd: null, computedFeeUsd: null, reason: "attribution_underpowered" };
  }
  const computedFeeUsd = Math.round(incrementalUsd * rate * 100) / 100;
  return { chargeable: false, ratePct, baseIncrementalUsd: incrementalUsd, computedFeeUsd, reason: "computed" };
}
