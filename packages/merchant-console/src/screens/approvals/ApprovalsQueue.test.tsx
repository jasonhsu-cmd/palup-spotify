import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Proposal } from "@palup/platform-ports";
import type { ApiClient } from "../../app/api";
import { ApprovalsQueue } from "./ApprovalsQueue";
import { formatImpact } from "./format";

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "p1",
    tenantId: "t1",
    agentId: "agent-winback",
    agentType: "win_back",
    action: { type: "send_campaign", params: {} },
    category: "campaign",
    rationale: "Win back 210 lapsed VIPs with a personal note",
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

function fakeApi(items: Proposal[]): Pick<ApiClient, "listApprovals"> {
  return { listApprovals: vi.fn(async () => ({ items })) };
}

describe("ApprovalsQueue", () => {
  it("renders a pending proposal with its category badge, rationale, and impact", async () => {
    const winBack = proposal();
    render(<ApprovalsQueue api={fakeApi([winBack])} />);

    expect(await screen.findByText(winBack.rationale)).toBeInTheDocument();
    expect(screen.getByText(/campaign/i)).toBeInTheDocument(); // category badge
    expect(screen.getByText(formatImpact(winBack))).toBeInTheDocument(); // reach + $
    expect(screen.getByText(/irreversible/i)).toBeInTheDocument(); // irreversible marker
  });

  it("shows a loading state before the fetch resolves", () => {
    const neverResolves: Pick<ApiClient, "listApprovals"> = {
      listApprovals: vi.fn(() => new Promise<{ items: Proposal[] }>(() => {})),
    };
    render(<ApprovalsQueue api={neverResolves} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("shows an empty 'all caught up' state when there is nothing pending", async () => {
    render(<ApprovalsQueue api={fakeApi([])} />);
    expect(await screen.findByText(/you're all caught up/i)).toBeInTheDocument();
  });

  it("renders exactly one row per pending proposal — the count matches", async () => {
    const items = [
      proposal({ id: "p1" }),
      proposal({ id: "p2", rationale: "Adjust ad spend +$50/day", category: "ad_spend" }),
    ];
    render(<ApprovalsQueue api={fakeApi(items)} />);
    expect(await screen.findAllByRole("button", { name: "Review" })).toHaveLength(2);
  });

  it("calls onSelect with the proposal id when Review is clicked", async () => {
    const onSelect = vi.fn();
    render(<ApprovalsQueue api={fakeApi([proposal({ id: "p1" })])} onSelect={onSelect} />);
    await userEvent.click(await screen.findByRole("button", { name: "Review" }));
    expect(onSelect).toHaveBeenCalledWith("p1");
  });

  it("re-fetches when `refreshKey` changes (e.g. after an approve/reject reconciles, T7 assembly) — same `api` reference both times", async () => {
    const api = fakeApi([]); // one stable object — proves the re-fetch is driven by refreshKey, not a new `api` prop
    const { rerender } = render(<ApprovalsQueue api={api} refreshKey={0} />);
    await waitFor(() => expect(api.listApprovals).toHaveBeenCalledTimes(1));

    rerender(<ApprovalsQueue api={api} refreshKey={1} />);
    await waitFor(() => expect(api.listApprovals).toHaveBeenCalledTimes(2));

    rerender(<ApprovalsQueue api={api} refreshKey={1} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(api.listApprovals).toHaveBeenCalledTimes(2); // an unchanged refreshKey never re-fetches
  });

  it("shows an error state and can retry when the fetch fails", async () => {
    let calls = 0;
    const listApprovals = vi.fn<ApiClient["listApprovals"]>(async () => {
      calls += 1;
      if (calls === 1) throw new Error("network down");
      return { items: [] };
    });
    render(<ApprovalsQueue api={{ listApprovals }} />);
    expect(await screen.findByText(/couldn.t load/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByText(/you're all caught up/i)).toBeInTheDocument();
  });
});
