import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatTile } from "../src/components/stat-tile";

describe("StatTile", () => {
  it("renders label, value, an 'up' delta, and a footnote", () => {
    render(
      <StatTile
        label="Attributed revenue"
        value="$18,204"
        delta={{ direction: "up", label: "+12% vs last 30d" }}
        footnote="Incremental, holdout-verified"
      />
    );
    expect(screen.getByText("Attributed revenue")).toBeTruthy();
    expect(screen.getByText("$18,204")).toBeTruthy();
    const delta = screen.getByText("+12% vs last 30d", { exact: false });
    expect(delta.classList.contains("bg-pos-soft")).toBe(true);
    expect(screen.getByText("Incremental, holdout-verified")).toBeTruthy();
  });

  it("uses the danger tint for a 'down' delta and omits the footnote when absent", () => {
    render(
      <StatTile label="Net" value="-$120" delta={{ direction: "down", label: "-4% vs last 30d" }} />
    );
    const delta = screen.getByText("-4% vs last 30d", { exact: false });
    expect(delta.classList.contains("bg-dang-soft")).toBe(true);
  });

  it("switches the value to the mono/tabular style when mono={true}", () => {
    render(<StatTile label="Orders" value="1,284" mono />);
    const value = screen.getByText("1,284");
    expect(value.classList.contains("font-mono")).toBe(true);
  });
});
