import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Proposal } from "@palup/platform-ports";
import { ConflictError, KilledError } from "../../app/api";
import { ApproveDialog } from "./ApproveDialog";

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

describe("ApproveDialog", () => {
  it("opens a focus-trapped, aria-modal confirm dialog from the Approve trigger", async () => {
    render(<ApproveDialog api={{ approve: vi.fn() }} proposal={proposal()} />);
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("confirming calls approve with the proposal's id and CURRENT version, then reconciles", async () => {
    const p = proposal({ id: "p9", version: 5 });
    const approve = vi.fn(async () => ({ ...p, version: 6, status: "approved" as const }));
    const onApproved = vi.fn();

    render(<ApproveDialog api={{ approve }} proposal={p} onApproved={onApproved} />);
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm approve" }));

    expect(approve).toHaveBeenCalledWith("p9", 5);
    await waitFor(() => expect(onApproved).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).toBeNull(); // closes on success
  });

  it("a 409 (ConflictError) shows the conflict message, triggers a re-fetch, and keeps the dialog open", async () => {
    const approve = vi.fn(async () => {
      throw new ConflictError(7);
    });
    const onConflict = vi.fn();

    render(<ApproveDialog api={{ approve }} proposal={proposal()} onConflict={onConflict} />);
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm approve" }));

    expect(await screen.findByText(/someone else already decided this/i)).toBeInTheDocument();
    expect(onConflict).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("a 423 (KilledError) shows the kill banner and disables approve — even after closing", async () => {
    const approve = vi.fn(async () => {
      throw new KilledError("safety incident");
    });

    render(<ApproveDialog api={{ approve }} proposal={proposal()} />);
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm approve" }));

    expect(await screen.findByText(/kill switch armed/i)).toBeInTheDocument();
    expect(screen.getByText(/safety incident/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm approve" })).toBeDisabled();

    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
  });

  it("an externally-supplied `killed` prop (the global Kill Switch, T6/T7) disables Approve on its own — no local 423 required", async () => {
    const approve = vi.fn();
    render(<ApproveDialog api={{ approve }} proposal={proposal()} killed />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(approve).not.toHaveBeenCalled();
  });

  it("calls the injected notify hook on a successful approve", async () => {
    const p = proposal();
    const approve = vi.fn(async () => ({ ...p, status: "approved" as const }));
    const notify = vi.fn();

    render(<ApproveDialog api={{ approve }} proposal={p} notify={notify} />);
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm approve" }));

    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
  });
});
