import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { HomeSummary } from "../../app/api";
import { NetPositionCard } from "./NetPositionCard";

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

describe("NetPositionCard", () => {
  it("renders a real positive net with both honest sides itemized", () => {
    render(
      <NetPositionCard
        summary={summary({
          attributed: { totalUsd: 150, entryCount: 2, plays: [], underpowered: false },
          cost: { metered: true, totalUsd: 12.5, fullyPriced: true, unpricedModels: [], events: 40 },
          net: { value: 137.5, reason: "ok" },
        })}
      />,
    );
    expect(screen.getByText("$137.50")).toBeInTheDocument();
    expect(screen.getByText("Incremental revenue created")).toBeInTheDocument();
    expect(screen.getByText("$150.00")).toBeInTheDocument();
    expect(screen.getByText("Model cost (measured)")).toBeInTheDocument();
    expect(screen.getByText("−$12.50")).toBeInTheDocument();
  });

  it("shows a NEGATIVE net honestly with the fix-it note — never hidden (spec §10)", () => {
    render(
      <NetPositionCard
        summary={summary({
          attributed: { totalUsd: 1, entryCount: 1, plays: [], underpowered: false },
          cost: { metered: true, totalUsd: 1.5, fullyPriced: true, unpricedModels: [], events: 3 },
          net: { value: -0.5, reason: "ok" },
        })}
      />,
    );
    expect(screen.getByText("−$0.50")).toBeInTheDocument();
    expect(screen.getByText(/currently costs more than the incremental revenue/i)).toBeInTheDocument();
    expect(screen.getByText(/tighten what runs automatically in Automation Rules/i)).toBeInTheDocument();
  });

  it("still-measuring state: no number is fabricated while attribution is underpowered", () => {
    render(<NetPositionCard summary={summary()} />);
    expect(screen.getByText(/still measuring/i)).toBeInTheDocument();
    expect(screen.getByText(/holdout/i)).toBeInTheDocument();
    expect(screen.queryByText(/^\$/)).toBeNull();
  });

  it("withholds net when cost is not metered, saying so", () => {
    render(
      <NetPositionCard
        summary={summary({
          attributed: { totalUsd: 100, entryCount: 1, plays: [], underpowered: false },
          net: { value: null, reason: "cost_not_metered" },
        })}
      />,
    );
    expect(screen.getByText(/model cost isn't metered for this period yet/i)).toBeInTheDocument();
    expect(screen.getByText("$100.00")).toBeInTheDocument(); // the honest side still shows
  });

  it("withholds net when models are unpriced, labeling cost as a lower bound", () => {
    render(
      <NetPositionCard
        summary={summary({
          attributed: { totalUsd: 100, entryCount: 1, plays: [], underpowered: false },
          cost: { metered: true, totalUsd: 2, fullyPriced: false, unpricedModels: ["gemini-2.5-flash"], events: 9 },
          net: { value: null, reason: "cost_not_fully_priced" },
        })}
      />,
    );
    expect(screen.getByText(/some model costs aren't priced yet/i)).toBeInTheDocument();
    expect(screen.getByText(/≥ \$2\.00/)).toBeInTheDocument();
  });
});
