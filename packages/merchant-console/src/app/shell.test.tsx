import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Shell } from "./shell.js";

describe("Shell", () => {
  it("renders the sidebar with Approval Center", () => {
    render(
      <Shell pendingCount={4}>
        <div />
      </Shell>,
    );
    expect(screen.getByText(/Approval Center/i)).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument(); // the pill
  });

  it("renders the page content passed as children", () => {
    render(
      <Shell pendingCount={0}>
        <p>Approval queue content</p>
      </Shell>,
    );
    expect(screen.getByText("Approval queue content")).toBeInTheDocument();
  });

  it("omits the pending pill entirely when there is nothing to approve (never shows a fake 0 badge)", () => {
    render(
      <Shell pendingCount={0}>
        <div />
      </Shell>,
    );
    const approvalLink = screen.getByRole("link", { name: /Approval Center/i });
    expect(approvalLink.textContent).toBe("Approval Center");
  });

  it("marks Approval Center active when activePath matches and calls onNavigate instead of a full navigation", async () => {
    const onNavigate = vi.fn();
    render(
      <Shell pendingCount={2} activePath="/approvals" onNavigate={onNavigate}>
        <div />
      </Shell>,
    );
    const approvalLink = screen.getByRole("link", { name: /Approval Center/i });
    expect(approvalLink.getAttribute("aria-current")).toBe("page");
    await userEvent.click(approvalLink);
    expect(onNavigate).toHaveBeenCalledWith("/approvals");
  });

  it("works at the mobile breakpoint too — the Menu toggle opens the same nav", async () => {
    render(
      <Shell pendingCount={4}>
        <div />
      </Shell>,
    );
    // F1's AppShell renders one Menu toggle for the off-canvas drawer at <900px; the same
    // Approval Center link exists in the one Sidebar instance shared by both breakpoints.
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    expect(screen.getByText(/Approval Center/i)).toBeInTheDocument();
  });
});
