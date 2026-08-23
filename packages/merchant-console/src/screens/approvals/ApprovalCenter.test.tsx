import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Proposal } from "@palup/platform-ports";
import type { ApiClient, AuditEntry, ConsoleEvent } from "../../app/api";
import { ApprovalCenter } from "./ApprovalCenter";

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "p1",
    tenantId: "t1",
    agentId: "agent-winback",
    agentType: "win_back",
    action: { type: "send_campaign", params: {} },
    category: "campaign",
    rationale: "Win back 210 lapsed VIPs",
    boundaryReasons: [{ rule: "campaign_send", detail: "Sends over 100 recipients require approval" }],
    estimatedImpact: { amountUsd: 4200, reach: 210 },
    reversalPlan: { reversible: false, plan: "Emails cannot be unsent; a correction follow-up can be sent" },
    preconditions: {},
    status: "pending",
    version: 1,
    createdAt: "2026-08-20T00:00:00.000Z",
    expiresAt: "2026-08-23T00:00:00.000Z",
    ...overrides,
  };
}

function auditEntry(): AuditEntry {
  return { seq: 1, at: "2026-08-20T00:00:00.000Z", actor: "owner", action: "proposal.approved", hash: "h1" };
}

function fakeApi(initialItems: Proposal[]): ApiClient & { emit: (e: ConsoleEvent) => void } {
  let items = initialItems;
  let killed = false;
  let listener: ((e: ConsoleEvent) => void) | undefined;
  return {
    listApprovals: vi.fn(async () => ({ items })),
    getApproval: vi.fn(async (id: string) => {
      const found = items.find((p) => p.id === id);
      if (!found) throw new Error("not found");
      return found;
    }),
    approve: vi.fn(async (id: string, version: number) => {
      const updated = { ...items.find((p) => p.id === id)!, status: "approved" as const, version: version + 1 };
      items = items.filter((p) => p.id !== id);
      return updated;
    }),
    reject: vi.fn(async (id: string, _reason: string) => {
      const updated = { ...items.find((p) => p.id === id)!, status: "rejected" as const };
      items = items.filter((p) => p.id !== id);
      return updated;
    }),
    getKill: vi.fn(async () => ({ killed })),
    kill: vi.fn(async (_reason: string) => {
      killed = true;
    }),
    unkill: vi.fn(async () => {
      killed = false;
    }),
    listAudit: vi.fn(async () => ({ items: [auditEntry()] })),
    openEvents: vi.fn((onEvent: (e: ConsoleEvent) => void) => {
      listener = onEvent;
      return () => {
        listener = undefined;
      };
    }),
    emit: (e: ConsoleEvent) => listener?.(e),
  };
}

describe("ApprovalCenter (assembly)", () => {
  it("renders the queue, the audit log, and no halted banner when nothing is killed", async () => {
    const api = fakeApi([proposal()]);
    render(<ApprovalCenter api={api} />);

    expect(await screen.findByText(proposal().rationale)).toBeInTheDocument();
    expect(await screen.findByText("owner")).toBeInTheDocument(); // audit row
    expect(screen.queryByText(/agents halted/i)).toBeNull();
  });

  it("Review opens the detail view, and approving reconciles the queue back to empty (the important gap)", async () => {
    const p = proposal({ id: "p1", version: 3 });
    const api = fakeApi([p]);
    render(<ApprovalCenter api={api} />);

    await userEvent.click(await screen.findByRole("button", { name: "Review" }));
    expect(await screen.findByRole("button", { name: "Approve" })).toBeInTheDocument();

    const callsBefore = (api.listApprovals as ReturnType<typeof vi.fn>).mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm approve" }));

    await waitFor(() =>
      expect((api.listApprovals as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callsBefore),
    );
    expect(api.approve).toHaveBeenCalledWith("p1", 3);
    await waitFor(() => expect(screen.getByText(/you're all caught up/i)).toBeInTheDocument());
  });

  it("Review then Reject reconciles the queue back to empty", async () => {
    const p = proposal({ id: "p1" });
    const api = fakeApi([p]);
    render(<ApprovalCenter api={api} />);

    await userEvent.click(await screen.findByRole("button", { name: "Review" }));
    await userEvent.click(await screen.findByRole("button", { name: "Reject" }));
    await userEvent.type(screen.getByLabelText(/reason/i), "not on-brand");

    const callsBefore = (api.listApprovals as ReturnType<typeof vi.fn>).mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: "Confirm reject" }));

    await waitFor(() =>
      expect((api.listApprovals as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callsBefore),
    );
    expect(api.reject).toHaveBeenCalledWith("p1", "not on-brand");
    await waitFor(() => expect(screen.getByText(/you're all caught up/i)).toBeInTheDocument());
  });

  it("halting via the Kill Switch shows the banner and disables Approve for a proposal already open in detail", async () => {
    const p = proposal({ id: "p1" });
    const api = fakeApi([p]);
    render(<ApprovalCenter api={api} />);

    await userEvent.click(await screen.findByRole("button", { name: "Review" }));
    expect(await screen.findByRole("button", { name: "Approve" })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "Halt all agents" }));
    await userEvent.type(screen.getByLabelText(/reason/i), "safety incident");
    await userEvent.click(screen.getByRole("button", { name: "Confirm halt" }));

    await waitFor(() => expect(screen.getByText(/agents halted/i)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled());
  });

  it("a live SSE proposal.created event refreshes the queue without any user action", async () => {
    const api = fakeApi([]);
    render(<ApprovalCenter api={api} />);
    await waitFor(() => expect(screen.getByText(/you're all caught up/i)).toBeInTheDocument());

    const newProposal = proposal({ id: "p2", rationale: "Adjust ad spend +$50/day", category: "ad_spend" });
    (api.listApprovals as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ items: [newProposal] }));
    api.emit({ type: "proposal.created", id: "p2" });

    expect(await screen.findByText(newProposal.rationale)).toBeInTheDocument();
  });
});
