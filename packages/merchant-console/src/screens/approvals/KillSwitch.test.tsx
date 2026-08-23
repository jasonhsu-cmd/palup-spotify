import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { Proposal } from "@palup/platform-ports";
import { ApiError } from "../../app/api";
import { KillSwitch } from "./KillSwitch";
import { ApproveDialog } from "./ApproveDialog";

function proposal(): Proposal {
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
  };
}

describe("KillSwitch", () => {
  it("renders no halted banner and a 'Halt all agents' control when not killed", () => {
    render(<KillSwitch api={{ kill: vi.fn(), unkill: vi.fn() }} killed={false} />);
    expect(screen.queryByText(/agents halted/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Halt all agents" })).toBeInTheDocument();
  });

  it("halting requires a confirm dialog and a non-empty reason, then calls kill(reason)", async () => {
    const kill = vi.fn(async () => {});
    render(<KillSwitch api={{ kill, unkill: vi.fn() }} killed={false} />);

    await userEvent.click(screen.getByRole("button", { name: "Halt all agents" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");

    const confirm = screen.getByRole("button", { name: "Confirm halt" });
    expect(confirm).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/reason/i), "safety incident");
    await userEvent.click(confirm);

    expect(kill).toHaveBeenCalledWith("safety incident");
  });

  it("calls onChanged after a successful halt so the caller re-fetches the real kill state", async () => {
    const kill = vi.fn(async () => {});
    const onChanged = vi.fn();
    render(<KillSwitch api={{ kill, unkill: vi.fn() }} killed={false} onChanged={onChanged} />);

    await userEvent.click(screen.getByRole("button", { name: "Halt all agents" }));
    await userEvent.type(screen.getByLabelText(/reason/i), "safety incident");
    await userEvent.click(screen.getByRole("button", { name: "Confirm halt" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("shows a red, live-region 'Agents halted' banner and a Resume control when killed=true", () => {
    render(<KillSwitch api={{ kill: vi.fn(), unkill: vi.fn() }} killed={true} />);
    const banner = screen.getByText(/agents halted/i);
    const region = banner.closest('[role="alert"]');
    expect(region).not.toBeNull();
    expect(region).toHaveAttribute("aria-live", "assertive");
    expect(screen.getByRole("button", { name: "Resume agents" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Halt all agents" })).toBeNull();
  });

  it("resuming confirms, calls unkill(), and calls onChanged", async () => {
    const unkill = vi.fn(async () => {});
    const onChanged = vi.fn();
    render(<KillSwitch api={{ kill: vi.fn(), unkill }} killed={true} onChanged={onChanged} />);

    await userEvent.click(screen.getByRole("button", { name: "Resume agents" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: "Confirm resume" }));

    expect(unkill).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("a 403 on unkill shows 'you don't have permission to resume' and does not call onChanged", async () => {
    const unkill = vi.fn(async () => {
      throw new ApiError(403, "forbidden");
    });
    const onChanged = vi.fn();
    render(<KillSwitch api={{ kill: vi.fn(), unkill }} killed={true} onChanged={onChanged} />);

    await userEvent.click(screen.getByRole("button", { name: "Resume agents" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm resume" }));

    expect(await screen.findByText(/you don't have permission to resume/i)).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
    // still shows as halted — a failed resume must never look like it worked
    expect(screen.getByText(/agents halted/i)).toBeInTheDocument();
  });

  // Integration check: the same `killed` boolean this component reflects (T6) is also what
  // disables ApproveDialog everywhere else (T4's `killed` prop) — this is the real wiring the
  // Approval Center screen (assembly) relies on, not just each component's own internal state.
  it("wired to a real ApproveDialog: halting via the confirm dialog disables Approve, resuming re-enables it", async () => {
    function Harness() {
      const [killed, setKilled] = useState(false);
      return (
        <>
          <KillSwitch
            api={{ kill: vi.fn(async () => {}), unkill: vi.fn(async () => {}) }}
            killed={killed}
            onChanged={() => setKilled((k) => !k)}
          />
          <ApproveDialog api={{ approve: vi.fn() }} proposal={proposal()} killed={killed} />
        </>
      );
    }
    render(<Harness />);

    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "Halt all agents" }));
    await userEvent.type(screen.getByLabelText(/reason/i), "safety incident");
    await userEvent.click(screen.getByRole("button", { name: "Confirm halt" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled());

    await userEvent.click(screen.getByRole("button", { name: "Resume agents" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm resume" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled());
  });
});
