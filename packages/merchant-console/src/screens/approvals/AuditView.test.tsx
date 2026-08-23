import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ApiClient, AuditEntry } from "../../app/api";
import { AuditView } from "./AuditView";

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    seq: 1,
    at: "2026-08-20T14:22:00.000Z",
    actor: "owner",
    action: "proposal.approved",
    reversalPath: "Emails cannot be unsent",
    hash: "abc123",
    ...overrides,
  };
}

describe("AuditView", () => {
  it("shows a loading state before the fetch resolves", () => {
    const api: Pick<ApiClient, "listAudit"> = {
      listAudit: vi.fn(() => new Promise<{ items: AuditEntry[] }>(() => {})),
    };
    render(<AuditView api={api} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("renders each audit entry's actor, action, and reversal path", async () => {
    const items = [entry({ seq: 1, actor: "owner", action: "proposal.approved" }), entry({ seq: 2, actor: "Aria", action: "proposal.rejected", reversalPath: undefined })];
    const api: Pick<ApiClient, "listAudit"> = { listAudit: vi.fn(async () => ({ items })) };
    render(<AuditView api={api} />);

    expect(await screen.findByText("owner")).toBeInTheDocument();
    expect(screen.getByText("proposal.approved")).toBeInTheDocument();
    expect(screen.getByText("Emails cannot be unsent")).toBeInTheDocument();
    expect(screen.getByText("Aria")).toBeInTheDocument();
    expect(screen.getByText("proposal.rejected")).toBeInTheDocument();
  });

  it("shows an empty state when there are no audit entries yet", async () => {
    const api: Pick<ApiClient, "listAudit"> = { listAudit: vi.fn(async () => ({ items: [] })) };
    render(<AuditView api={api} />);
    expect(await screen.findByText(/no audit entries yet/i)).toBeInTheDocument();
  });

  it("shows an error state and can retry when the fetch fails", async () => {
    let calls = 0;
    const listAudit = vi.fn<ApiClient["listAudit"]>(async () => {
      calls += 1;
      if (calls === 1) throw new Error("network down");
      return { items: [entry()] };
    });
    render(<AuditView api={{ listAudit }} />);
    expect(await screen.findByText(/couldn.t load/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByText("owner")).toBeInTheDocument();
  });
});
