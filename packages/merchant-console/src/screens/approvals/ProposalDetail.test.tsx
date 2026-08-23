import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Proposal } from "@palup/platform-ports";
import { ProposalDetail } from "./ProposalDetail";
import { formatImpact } from "./format";

function irreversibleCampaign(): Proposal {
  return {
    id: "p1",
    tenantId: "t1",
    agentId: "agent-winback",
    agentType: "win_back",
    action: { type: "send_campaign", params: {}, irreversible: true, blastRadius: 210 },
    category: "campaign",
    rationale: "Win back 210 lapsed VIPs with a personal 20% note",
    boundaryReasons: [
      { rule: "discount_ceiling", detail: "20% offer is above your 15% auto-approve rule" },
      { rule: "campaign_send", detail: "Sends over 100 recipients always require approval" },
    ],
    estimatedImpact: { amountUsd: 4200, reach: 210 },
    reversalPlan: { reversible: false, plan: "Emails cannot be unsent; Aria can send a correction follow-up" },
    preconditions: {},
    status: "pending",
    version: 3,
    createdAt: "2026-08-20T00:00:00.000Z",
    expiresAt: "2026-08-23T00:00:00.000Z",
  };
}

describe("ProposalDetail", () => {
  it("shows the reversal plan, an irreversible warning, every boundary reason, and the reach", () => {
    const proposal = irreversibleCampaign();
    render(<ProposalDetail proposal={proposal} />);

    expect(screen.getByText(proposal.reversalPlan.plan)).toBeInTheDocument();
    expect(screen.getByText(/irreversible/i)).toBeInTheDocument();
    for (const reason of proposal.boundaryReasons) {
      expect(screen.getByText(reason.detail)).toBeInTheDocument();
    }
    expect(screen.getByText(formatImpact(proposal))).toBeInTheDocument();
  });

  it("shows a reversible (non-warning) callout when the plan says it can be undone", () => {
    const proposal = irreversibleCampaign();
    proposal.reversalPlan = { reversible: true, plan: "Pausing the campaign stops all further sends immediately" };
    render(<ProposalDetail proposal={proposal} />);

    expect(screen.queryByText(/irreversible/i)).toBeNull();
    expect(screen.getByText(proposal.reversalPlan.plan)).toBeInTheDocument();
  });

  it("renders the optional actions slot when provided", () => {
    render(<ProposalDetail proposal={irreversibleCampaign()} actions={<button>Approve</button>} />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });

  it("renders nothing extra for the actions slot when omitted", () => {
    render(<ProposalDetail proposal={irreversibleCampaign()} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("wires the real ApproveDialog when `api` is provided — confirm calls approve(id, version)", async () => {
    const p = irreversibleCampaign();
    const approve = vi.fn(async () => ({ ...p, version: p.version + 1, status: "approved" as const }));
    render(<ProposalDetail proposal={p} api={{ approve }} />);

    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm approve" }));

    expect(approve).toHaveBeenCalledWith(p.id, p.version);
  });
});
