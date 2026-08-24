import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OnboardingHandoff } from "../../app/api";
import { HandoffCard } from "./HandoffCard";

const handoff: OnboardingHandoff = {
  headline: "Welcome to PalUp — I picked up where we left off",
  items: [
    { label: "Shade and ingredient Q&A is on.", detail: "I answer these in live chat 24/7." },
    { label: "Your goal — recover more carts — is first in line.", detail: "It's the first play this week." },
  ],
  sourceNote: "This is from your signup conversation with PalUp — kept separate from your customers' data.",
};

describe("HandoffCard", () => {
  it("renders the headline, every item, and the data-separation source note", () => {
    render(<HandoffCard handoff={handoff} onDismiss={vi.fn()} />);
    expect(screen.getByText(handoff.headline)).toBeInTheDocument();
    expect(screen.getByText("Shade and ingredient Q&A is on.")).toBeInTheDocument();
    expect(screen.getByText("It's the first play this week.")).toBeInTheDocument();
    expect(screen.getByText(/kept separate from your customers/)).toBeInTheDocument();
  });

  it("fires onDismiss from the labeled dismiss control", async () => {
    const onDismiss = vi.fn();
    render(<HandoffCard handoff={handoff} onDismiss={onDismiss} />);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
