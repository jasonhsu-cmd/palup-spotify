import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { PaymentsScreen } from "./PaymentsView";
import type { PaymentsView } from "../../app/api";

// W5 Task 12 — Payments & Payouts screen tests. TRUST ANCHOR + COMPUTED-NOT-CHARGED is the whole
// point: the fee line must read as illustrative, never as money owed/charged, and an underpowered
// attribution must never show a fabricated $0 fee.

const base = (over: Partial<PaymentsView> = {}): PaymentsView => ({
  period: "2026-08",
  payouts: [],
  payoutTotalUsd: 0,
  fee: { chargeable: false, ratePct: 6, baseIncrementalUsd: null, computedFeeUsd: null, reason: "attribution_underpowered" },
  payoutsAdminPath: "admin/settings/payments",
  trustNote: "PalUp never touches your money.",
  ...over,
});

describe("PaymentsScreen", () => {
  it("renders the trust anchor verbatim", async () => {
    render(<PaymentsScreen api={{ getPayments: async () => base() }} />);
    await waitFor(() => expect(screen.getByText(/never touches your money/i)).toBeInTheDocument());
  });

  it("shows the fee line as computed-not-charged, never a $0 when underpowered", async () => {
    render(<PaymentsScreen api={{ getPayments: async () => base() }} />);
    await waitFor(() => expect(screen.getByText(/not charged/i)).toBeInTheDocument());
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    expect(screen.getByText(/proven incremental/i)).toBeInTheDocument();
  });

  it("shows the computed fee amount when powered", async () => {
    render(
      <PaymentsScreen
        api={{
          getPayments: async () =>
            base({ fee: { chargeable: false, ratePct: 6, baseIncrementalUsd: 1000, computedFeeUsd: 60, reason: "computed" } }),
        }}
      />,
    );
    await waitFor(() => expect(screen.getByText("$60.00")).toBeInTheDocument());
  });

  it("never presents the fee as chargeable (honors FeeLine.chargeable === false)", async () => {
    render(
      <PaymentsScreen
        api={{
          getPayments: async () =>
            base({ fee: { chargeable: false, ratePct: 6, baseIncrementalUsd: 1000, computedFeeUsd: 60, reason: "computed" } }),
        }}
      />,
    );
    await waitFor(() => expect(screen.getByText("$60.00")).toBeInTheDocument());
    expect(screen.getByText(/computed.*not charged/i)).toBeInTheDocument();
    expect(screen.queryByText(/amount due|you owe|charged to your account/i)).not.toBeInTheDocument();
  });

  it("renders payouts read-through from Shopify with a deep-link to Shopify payout settings", async () => {
    render(
      <PaymentsScreen
        api={{
          getPayments: async () =>
            base({
              payoutTotalUsd: 500,
              payouts: [{ id: "po_1", status: "paid", amountUsd: 500, currency: "USD", issuedAt: "2026-08-20T00:00:00Z" }],
            }),
        }}
      />,
    );
    await waitFor(() => expect(screen.getAllByText("$500.00").length).toBeGreaterThan(0));
    expect(screen.getByRole("link", { name: /shopify/i })).toHaveAttribute("href", expect.stringContaining("admin/settings/payments"));
  });

  it("shows an honest empty state when there are no payouts yet", async () => {
    render(<PaymentsScreen api={{ getPayments: async () => base() }} />);
    await waitFor(() => expect(screen.getByText(/no payouts to show yet/i)).toBeInTheDocument());
  });

  it("shows an honest error state with retry on failure", async () => {
    const api = { getPayments: async () => { throw new Error("boom"); } };
    render(<PaymentsScreen api={api} />);
    await waitFor(() => expect(screen.getByText(/couldn.t load payments/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("shows a loading state before data resolves", () => {
    render(<PaymentsScreen api={{ getPayments: () => new Promise(() => {}) }} />);
    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);
  });
});
