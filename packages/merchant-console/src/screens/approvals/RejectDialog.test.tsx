import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Proposal } from "@palup/platform-ports";
import { ConflictError } from "../../app/api";
import { RejectDialog } from "./RejectDialog";

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "p1",
    tenantId: "t1",
    agentId: "agent-winback",
    agentType: "win_back",
    action: { type: "send_campaign", params: {} },
    category: "campaign",
    rationale: "Win back 210 lapsed VIPs",
    boundaryReasons: [],
    estimatedImpact: { amountUsd: 4200, reach: 210 },
    reversalPlan: { reversible: false, plan: "Cannot un-send; a correction follow-up can be sent" },
    preconditions: {},
    status: "pending",
    version: 5,
    createdAt: "2026-08-20T00:00:00.000Z",
    expiresAt: "2026-08-23T00:00:00.000Z",
    ...overrides,
  };
}

describe("RejectDialog", () => {
  it("opens a focus-trapped confirm dialog from the Reject trigger, with confirm disabled until a reason is typed", async () => {
    render(<RejectDialog api={{ reject: vi.fn() }} proposal={proposal()} />);
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");

    const confirm = screen.getByRole("button", { name: "Confirm reject" });
    expect(confirm).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/reason/i), "Not aligned with brand voice");
    expect(confirm).toBeEnabled();
  });

  it("never calls reject while the reason is empty or only whitespace", async () => {
    const reject = vi.fn();
    render(<RejectDialog api={{ reject }} proposal={proposal()} />);
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    await userEvent.type(screen.getByLabelText(/reason/i), "   ");
    expect(screen.getByRole("button", { name: "Confirm reject" })).toBeDisabled();
    expect(reject).not.toHaveBeenCalled();
  });

  it("confirming calls reject with the id and trimmed reason, closes, and reconciles the queue", async () => {
    const p = proposal({ id: "p9" });
    const reject = vi.fn(async () => ({ ...p, status: "rejected" as const }));
    const onRejected = vi.fn();

    render(<RejectDialog api={{ reject }} proposal={p} onRejected={onRejected} />);
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    await userEvent.type(screen.getByLabelText(/reason/i), "  not on-brand  ");
    await userEvent.click(screen.getByRole("button", { name: "Confirm reject" }));

    expect(reject).toHaveBeenCalledWith("p9", "not on-brand");
    await waitFor(() => expect(onRejected).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a 409 (ConflictError) shows the conflict message, triggers a re-fetch, and keeps the dialog open", async () => {
    const reject = vi.fn(async () => {
      throw new ConflictError(7);
    });
    const onConflict = vi.fn();

    render(<RejectDialog api={{ reject }} proposal={proposal()} onConflict={onConflict} />);
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    await userEvent.type(screen.getByLabelText(/reason/i), "not on-brand");
    await userEvent.click(screen.getByRole("button", { name: "Confirm reject" }));

    expect(await screen.findByText(/someone else already decided this/i)).toBeInTheDocument();
    expect(onConflict).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("clears the typed reason after closing without submitting", async () => {
    render(<RejectDialog api={{ reject: vi.fn() }} proposal={proposal()} />);
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    await userEvent.type(screen.getByLabelText(/reason/i), "some reason");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(screen.getByLabelText(/reason/i)).toHaveValue("");
  });
});
