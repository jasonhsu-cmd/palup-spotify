import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Badge } from "../src/components/badge";

describe("Badge", () => {
  it("defaults to the gray variant and renders its text", () => {
    render(<Badge>3,104 orders</Badge>);
    const badge = screen.getByText("3,104 orders");
    expect(badge.classList.contains("bg-surface-3")).toBe(true);
  });

  it("applies the pos variant's tint classes", () => {
    render(<Badge variant="pos">High</Badge>);
    const badge = screen.getByText("High");
    expect(badge.classList.contains("bg-pos-soft")).toBe(true);
    expect(badge.classList.contains("text-pos")).toBe(true);
  });

  it("renders a status dot by default and omits it when dot={false}", () => {
    const { rerender } = render(<Badge variant="dang">At-risk</Badge>);
    expect(document.querySelectorAll(".bg-current").length).toBe(1);
    rerender(<Badge variant="dang" dot={false}>At-risk</Badge>);
    expect(document.querySelectorAll(".bg-current").length).toBe(0);
  });
});
