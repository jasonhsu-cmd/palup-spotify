import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ActivityEntry } from "../../app/api";
import { ActivityToday } from "./ActivityToday";

const items: ActivityEntry[] = [
  { seq: 4, at: "2026-08-24T04:00:00.000Z", actor: "u1", action: "proposal.approved" },
  { seq: 1, at: "2026-08-24T01:00:00.000Z", actor: "win_back_agent", action: "proposal.created" },
  { seq: 9, at: "2026-08-24T05:00:00.000Z", actor: "win_back_agent", action: "some.future.action" },
];

describe("ActivityToday", () => {
  it("renders merchant-worded labels for known actions and the raw slug for unknown ones", () => {
    render(<ActivityToday items={items} />);
    expect(screen.getByText("Proposal approved")).toBeInTheDocument();
    expect(screen.getByText("Drafted a proposal for your approval")).toBeInTheDocument();
    expect(screen.getByText("some.future.action")).toBeInTheDocument(); // honest fallback, never dropped
  });

  it("shows the actor on each row", () => {
    render(<ActivityToday items={items} />);
    expect(screen.getAllByText("win_back_agent").length).toBeGreaterThan(0);
  });

  it("honest empty state when there is no recorded activity", () => {
    render(<ActivityToday items={[]} />);
    expect(screen.getByText(/no agent activity recorded yet/i)).toBeInTheDocument();
  });
});
