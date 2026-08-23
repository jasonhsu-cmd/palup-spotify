import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button } from "../src/components/button";

describe("Button", () => {
  it("renders the primary variant (evergreen background) by default", () => {
    render(<Button>Approve</Button>);
    const btn = screen.getByRole("button", { name: "Approve" });
    expect(btn.classList.contains("bg-ever")).toBe(true);
  });

  it("applies the danger variant's background class", () => {
    render(<Button variant="danger">Reject</Button>);
    const btn = screen.getByRole("button", { name: "Reject" });
    expect(btn.classList.contains("bg-dang")).toBe(true);
  });

  it("applies the block modifier as a full-width class", () => {
    render(<Button block>Save changes</Button>);
    const btn = screen.getByRole("button", { name: "Save changes" });
    expect(btn.classList.contains("w-full")).toBe(true);
  });

  it("fires onClick when enabled, and never fires when disabled", async () => {
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} disabled>
        Approve
      </Button>
    );
    const btn = screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await userEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });
});
