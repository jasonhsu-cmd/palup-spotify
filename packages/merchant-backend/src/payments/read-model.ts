import { computeFeeLine, type FeeLine, type Payout, type PayoutsPort, type RuntimeStatePort } from "@palup/platform-ports";
import { readOutcomeLedger } from "@palup/state-postgres";
import { currentPeriod } from "../home/read-model.js";
import { shopifyPayoutsAdminPath } from "../shopify-links.js";

// W5 — the Payments & Payouts READ MODEL (spec §9 W5). Two honest halves:
//   payouts ← the PayoutsPort (Shopify's own money movements; PalUp never touches them). Dark until a
//             live Shopify-Payments adapter is human-enabled → empty list, never fabricated.
//   fee     ← the transparent, COMPUTED-NOT-CHARGED PalUp fee line, computed from the SAME canonical
//             incremental source W2's readHomeSummary uses (the outcome ledger, ADR-0007) — never from
//             payouts/GMV, and withheld (null) until attribution is powered (D2). No second attribution
//             path is computed here. Real billing is W6.
//
// READ MODEL ONLY — this module never writes anything and never moves money. `fee.chargeable` is
// always `false` (enforced by computeFeeLine's return type). A route (Task 6) is a later increment;
// nothing here is wired to serving traffic yet.

const LEDGER_READ_LIMIT = 10_000; // same bounded window as home/read-model.ts (D5 precedent)

/** The trust-anchor copy — the whole reason W5 exists. Rendered verbatim on the Payments screen. */
export const PALUP_TRUST_NOTE =
  "PalUp never touches your money. Payouts go straight from Shopify to your bank — we only read them. There's no card on file with PalUp.";

export interface PaymentsView {
  period: string;
  payouts: Payout[];
  payoutTotalUsd: number;
  fee: FeeLine;
  /** Shopify admin deep-link to payouts (money settings live in Shopify, not PalUp). */
  payoutsAdminPath: string;
  trustNote: string;
}

export async function readPaymentsView(
  payouts: PayoutsPort,
  state: RuntimeStatePort,
  tenantId: string,
  opts: { period?: string } = {},
): Promise<PaymentsView> {
  const period = opts.period ?? currentPeriod();

  const payoutRows = await payouts.listPayouts({ tenantId });
  const payoutTotalUsd = Math.round(payoutRows.reduce((sum, p) => sum + p.amountUsd, 0) * 100) / 100;

  // Canonical incremental (D2, ADR-0007): the SAME ledger-sum-over-period spine as W2's
  // readHomeSummary — no second attribution path. Powered iff the period has any reconciled entries.
  const ledger = await readOutcomeLedger(state, tenantId, { limit: LEDGER_READ_LIMIT });
  const periodEntries = ledger.filter((e) => e.period === period);
  const incrementalUsd = periodEntries.reduce((sum, e) => sum + e.attributedIncrementalRevenue, 0);
  const powered = periodEntries.length > 0;

  return {
    period,
    payouts: payoutRows,
    payoutTotalUsd,
    fee: computeFeeLine(incrementalUsd, powered),
    payoutsAdminPath: shopifyPayoutsAdminPath(),
    trustNote: PALUP_TRUST_NOTE,
  };
}
