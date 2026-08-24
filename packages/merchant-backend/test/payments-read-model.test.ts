import { describe, expect, it } from "vitest";
import { InMemoryRuntimeStore, SandboxPayoutsPort, type Payout } from "@palup/platform-ports";
import { appendOutcomeLedgerEntry } from "@palup/state-postgres";
import { readPaymentsView } from "../src/payments/read-model.js";

// W5 Task 5 — the Payments read model (spec §9 W5). Two honest halves:
//   payouts ← PayoutsPort (Shopify's own money movements; read-through only).
//   fee     ← computeFeeLine over the SAME canonical incremental source W2's readHomeSummary uses
//             (the outcome ledger, ADR-0007) — no second attribution path, never charged.
//
// M2 REVIEW FIX: the plan's draft test called `store.appendStream(...)`, which does not exist on
// RuntimeStatePort / InMemoryRuntimeStore. The canonical way to seed the outcome ledger is the
// `appendOutcomeLedgerEntry` helper (packages/state-postgres/src/outcome-ledger-store.ts), exactly as
// packages/merchant-backend/test/home-read-model.test.ts already does for W2. `InMemoryRuntimeStore`
// and `SandboxPayoutsPort` are exported from @palup/platform-ports (NOT @palup/state-postgres).

const T = "t";
const PERIOD = "2026-08";

const payout = (id: string, amt: number): Payout => ({
  id,
  status: "paid",
  amountUsd: amt,
  currency: "USD",
  issuedAt: "2026-08-20T00:00:00Z",
});

describe("readPaymentsView", () => {
  it("sums payouts and computes the fee from the canonical incremental ledger (powered)", async () => {
    const store = new InMemoryRuntimeStore();
    await appendOutcomeLedgerEntry(store, {
      merchantId: T,
      period: PERIOD,
      play: "winback",
      attributedIncrementalRevenue: 1000,
      controlRef: "holdout-2026-08",
      method: "holdout",
      confidence: 0.9,
    });
    const port = new SandboxPayoutsPort({ t: [payout("po1", 500), payout("po2", 250)] });

    const view = await readPaymentsView(port, store, T, { period: PERIOD });

    expect(view.payoutTotalUsd).toBe(750);
    expect(view.payouts).toHaveLength(2);
    expect(view.fee).toMatchObject({ chargeable: false, computedFeeUsd: 60, baseIncrementalUsd: 1000, reason: "computed" });
    expect(view.payoutsAdminPath).toBe("admin/settings/payments");
    expect(view.trustNote).toContain("never touches your money");
  });

  it("withholds the fee (underpowered) when the period has no ledger entries — never a fabricated $0", async () => {
    const store = new InMemoryRuntimeStore();
    const view = await readPaymentsView(new SandboxPayoutsPort(), store, T, { period: PERIOD });

    expect(view.payouts).toEqual([]);
    expect(view.payoutTotalUsd).toBe(0);
    expect(view.fee).toMatchObject({ chargeable: false, computedFeeUsd: null, baseIncrementalUsd: null, reason: "attribution_underpowered" });
  });

  it("ignores another period's ledger entries when computing the fee base", async () => {
    const store = new InMemoryRuntimeStore();
    await appendOutcomeLedgerEntry(store, {
      merchantId: T,
      period: "2026-07",
      play: "winback",
      attributedIncrementalRevenue: 999,
      controlRef: "holdout-2026-07",
      method: "holdout",
      confidence: 0.9,
    });

    const view = await readPaymentsView(new SandboxPayoutsPort(), store, T, { period: PERIOD });

    expect(view.fee).toMatchObject({ chargeable: false, computedFeeUsd: null, baseIncrementalUsd: null, reason: "attribution_underpowered" });
  });

  it("tenant scoping: another tenant's ledger and payouts never leak in", async () => {
    const store = new InMemoryRuntimeStore();
    await appendOutcomeLedgerEntry(store, {
      merchantId: "other",
      period: PERIOD,
      play: "winback",
      attributedIncrementalRevenue: 5000,
      controlRef: "holdout-2026-08",
      method: "holdout",
      confidence: 0.9,
    });
    const port = new SandboxPayoutsPort({ other: [payout("po-other", 9999)], t: [payout("po1", 500)] });

    const view = await readPaymentsView(port, store, T, { period: PERIOD });

    expect(view.payoutTotalUsd).toBe(500);
    expect(view.payouts).toHaveLength(1);
    expect(view.fee).toMatchObject({ chargeable: false, computedFeeUsd: null, baseIncrementalUsd: null, reason: "attribution_underpowered" });
  });

  it("defaults period to currentPeriod() when opts.period is omitted", async () => {
    const store = new InMemoryRuntimeStore();
    const view = await readPaymentsView(new SandboxPayoutsPort(), store, T);
    expect(typeof view.period).toBe("string");
    expect(view.period).toMatch(/^\d{4}-\d{2}$/);
  });
});
