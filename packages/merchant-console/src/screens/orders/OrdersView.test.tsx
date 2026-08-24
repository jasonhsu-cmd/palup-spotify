import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { OrdersView } from "./OrdersView";
import type { OrderView } from "../../app/api";

const order = (over: Partial<OrderView> = {}): OrderView => ({
  id: "1001", orderNumber: "#1001", placedAt: "2026-08-20T00:00:00Z", totalUsd: 42, currency: "USD",
  financialStatus: "paid", fulfillmentStatus: "unfulfilled", customerLabel: "Guest", touchpoints: [], adminPath: "admin/orders/1001", ...over,
});

describe("OrdersView", () => {
  it("renders orders with an honest 'no agent activity' touchpoint state and a Shopify deep-link", async () => {
    const api = { getOrders: async () => ({ items: [order()], source: "live" as const, sourceNote: "note" }) };
    render(<OrdersView api={api} />);
    await waitFor(() => expect(screen.getByText("#1001")).toBeInTheDocument());
    expect(screen.getByText(/no agent activity/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /manage in shopify/i })).toHaveAttribute("href", expect.stringContaining("admin/orders/1001"));
  });

  it("shows an honest unavailable state (no fabricated rows) when read-through is not connected", async () => {
    const api = { getOrders: async () => ({ items: [], source: "unavailable" as const, sourceNote: "Order read-through is not connected yet" }) };
    render(<OrdersView api={api} />);
    await waitFor(() => expect(screen.getByText(/not connected yet/i)).toBeInTheDocument());
  });

  it("shows a touchpoint count when the agent acted on an order", async () => {
    const api = { getOrders: async () => ({ items: [order({ touchpoints: [{ orderRef: "1001", seq: 3, at: "2026-08-20T01:00:00Z", actor: "agent:wb", action: "proposal.executed" }] })], source: "live" as const, sourceNote: "n" }) };
    render(<OrdersView api={api} />);
    await waitFor(() => expect(screen.getByText(/1 agent action/i)).toBeInTheDocument());
  });
});
