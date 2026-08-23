import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Note } from "../src/components/note";

describe("Note", () => {
  it("defaults to the info variant's tint classes", () => {
    render(<Note>Nearing your usage limit.</Note>);
    const note = screen.getByText("Nearing your usage limit.").closest("div");
    expect(note?.parentElement?.classList.contains("bg-info-soft")).toBe(true);
  });

  it("applies the warn variant and renders an icon when provided", () => {
    render(
      <Note variant="warn" icon={<svg data-testid="note-icon" />}>
        Approaching your approved limit.
      </Note>
    );
    expect(screen.getByTestId("note-icon")).toBeTruthy();
    const note = screen.getByText("Approaching your approved limit.").closest("div")?.parentElement;
    expect(note?.classList.contains("bg-warn-soft")).toBe(true);
    expect(note?.classList.contains("text-warn")).toBe(true);
  });

  it("omits the icon wrapper when no icon is passed", () => {
    render(<Note variant="dang">Kill switch engaged.</Note>);
    expect(document.querySelector("svg")).toBeNull();
  });
});
