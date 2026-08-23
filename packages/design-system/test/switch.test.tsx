import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Switch } from "../src/components/switch";

describe("Switch", () => {
  it("renders as an accessible switch, unchecked by default", () => {
    render(<Switch aria-label="Kill switch" />);
    const sw = screen.getByRole("switch", { name: "Kill switch" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(sw.classList.contains("bg-line")).toBe(true);
  });

  it("toggles aria-checked and calls onCheckedChange on click", async () => {
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="Kill switch" onCheckedChange={onCheckedChange} />);
    const sw = screen.getByRole("switch", { name: "Kill switch" });
    await userEvent.click(sw);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("applies the checked/evergreen background class when checked", () => {
    render(<Switch aria-label="Kill switch" checked onCheckedChange={() => {}} />);
    const sw = screen.getByRole("switch", { name: "Kill switch" });
    expect(sw.getAttribute("data-state")).toBe("checked");
  });
});
