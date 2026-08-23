import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppShell, type NavGroupItem } from "../src/components/app-shell";

const groups: NavGroupItem[] = [
  {
    title: "Overview",
    links: [
      { href: "/home", label: "Revenue Home", active: true },
      { href: "/inbox", label: "Inbox", pillCount: 3 },
    ],
  },
];

describe("AppShell + Sidebar", () => {
  it("marks the active link with aria-current and shows the pill count on another link", () => {
    render(
      <AppShell groups={groups}>
        <p>Page content</p>
      </AppShell>
    );
    const active = screen.getByRole("link", { name: "Revenue Home" });
    expect(active.getAttribute("aria-current")).toBe("page");
    const inbox = screen.getByRole("link", { name: /Inbox/ });
    expect(inbox.textContent).toContain("3");
    expect(screen.getByText("Page content")).toBeTruthy();
  });

  it("calls onNavigate with the href instead of navigating when a link is clicked", async () => {
    const onNavigate = vi.fn();
    render(
      <AppShell groups={groups} onNavigate={onNavigate}>
        <p>Page content</p>
      </AppShell>
    );
    await userEvent.click(screen.getByRole("link", { name: "Revenue Home" }));
    expect(onNavigate).toHaveBeenCalledWith("/home");
  });

  it("opens and closes the mobile drawer scrim via the Menu toggle", async () => {
    render(
      <AppShell groups={groups}>
        <p>Page content</p>
      </AppShell>
    );
    expect(document.querySelector('[aria-hidden="true"].bg-ink\\/40')).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    expect(document.querySelector('[aria-hidden="true"].bg-ink\\/40')).toBeTruthy();
    const scrim = document.querySelector('[aria-hidden="true"].bg-ink\\/40') as HTMLElement;
    await userEvent.click(scrim);
    expect(document.querySelector('[aria-hidden="true"].bg-ink\\/40')).toBeNull();
  });
});
