import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ActivityEntry, HomeSummary } from "../../app/api";
import { RevenueHome } from "./RevenueHome";

function summary(over: Partial<HomeSummary> = {}): HomeSummary {
  return {
    period: "2026-08",
    goal: null,
    attributed: { totalUsd: 0, entryCount: 0, plays: [], underpowered: true },
    cost: { metered: false, totalUsd: 0, fullyPriced: true, unpricedModels: [], events: 0 },
    net: { value: null, reason: "attribution_underpowered" },
    handoff: null,
    ...over,
  };
}

function fakeApi(s: HomeSummary, items: ActivityEntry[] = []) {
  return {
    getHomeSummary: vi.fn(async () => s),
    getActivity: vi.fn(async () => ({ items })),
  };
}

describe("RevenueHome", () => {
  it("Day-0: every tile is an HONEST state — no fabricated numbers anywhere", async () => {
    render(<RevenueHome api={fakeApi(summary())} />);
    expect(await screen.findByText("Still measuring")).toBeInTheDocument();
    expect(screen.getByText("Not yet metered")).toBeInTheDocument();
    expect(screen.getByText("No primary goal set yet")).toBeInTheDocument();
    expect(screen.getByText(/no plays are being measured yet/i)).toBeInTheDocument();
    // The mockup's demo values must never leak in.
    expect(screen.queryByText("$76,420")).toBeNull();
  });

  it("renders real attributed/cost/net values when the API has them, plus the goal chip", async () => {
    render(
      <RevenueHome
        api={fakeApi(
          summary({
            goal: { kind: "recover_carts", setBy: "u1", setAt: "2026-08-24T00:00:00.000Z" },
            attributed: {
              totalUsd: 150,
              entryCount: 2,
              plays: [{ play: "win_back", incrementalLiftUsd: 2250, relativeLift: 3, confidence: 0.99, underpowered: false, method: "m" }],
              underpowered: false,
            },
            cost: { metered: true, totalUsd: 12.5, fullyPriced: true, unpricedModels: [], events: 40 },
            net: { value: 137.5, reason: "ok" },
          }),
          [{ seq: 1, at: "2026-08-24T01:00:00.000Z", actor: "win_back_agent", action: "proposal.created" }],
        )}
      />,
    );
    // "$150.00" appears on BOTH the attributed tile and the net card's itemized row — assert ≥1,
    // never getByText (which throws on multiple matches).
    expect((await screen.findAllByText("$150.00")).length).toBeGreaterThan(0);
    expect(screen.getByText("$12.50")).toBeInTheDocument(); // cost tile (the net card row reads "−$12.50")
    expect(screen.getAllByText("$137.50").length).toBeGreaterThan(0); // net tile + card
    expect(screen.getByText("Recover more carts")).toBeInTheDocument(); // goal chip
    expect(screen.getByText("win_back")).toBeInTheDocument(); // measurement row
    expect(screen.getByText("Drafted a proposal for your approval")).toBeInTheDocument(); // activity
  });

  it("labels an unpriced cost as a lower bound on the tile", async () => {
    render(
      <RevenueHome
        api={fakeApi(
          summary({ cost: { metered: true, totalUsd: 2, fullyPriced: false, unpricedModels: ["gemini-2.5-flash"], events: 9 } }),
        )}
      />,
    );
    expect(await screen.findByText("≥ $2.00")).toBeInTheDocument();
    expect(screen.getByText(/some models unpriced/i)).toBeInTheDocument();
  });

  it("shows the handoff card when the API returns one and hides it on dismiss", async () => {
    render(
      <RevenueHome
        api={fakeApi(
          summary({
            handoff: {
              headline: "Welcome to PalUp — I picked up where we left off",
              items: [{ label: "Your goal is first in line.", detail: "Running this week." }],
              sourceNote: "From your signup conversation — kept separate from your customers' data.",
            },
          }),
        )}
      />,
    );
    expect(await screen.findByText(/picked up where we left off/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/picked up where we left off/)).toBeNull();
  });

  it("surfaces a load failure with a Retry that re-fetches", async () => {
    const api = {
      getHomeSummary: vi.fn<() => Promise<HomeSummary>>(async () => {
        throw new Error("boom");
      }),
      getActivity: vi.fn(async () => ({ items: [] as ActivityEntry[] })),
    };
    render(<RevenueHome api={api} />);
    expect(await screen.findByText(/couldn't load revenue home/i)).toBeInTheDocument();
    api.getHomeSummary.mockImplementation(async () => summary());
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Still measuring")).toBeInTheDocument();
  });
});
