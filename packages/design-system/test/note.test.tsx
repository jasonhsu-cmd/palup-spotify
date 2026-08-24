import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Note } from "../src/components/note";

describe("Note", () => {
  it("defaults to the info variant's tint background and AA-compliant on-tint ink text", () => {
    render(<Note>Nearing your usage limit.</Note>);
    const note = screen.getByText("Nearing your usage limit.").closest("div")?.parentElement;
    expect(note?.classList.contains("bg-info-soft")).toBe(true);
    // text-info (#2B66D9) on bg-info-soft fails WCAG AA (~4.39:1); the dedicated on-tint ink
    // token (#1B4596, ~7.7:1) is required instead — see note-contrast.test.ts.
    expect(note?.classList.contains("text-note-info-ink")).toBe(true);
  });

  it("applies the warn variant's AA-compliant on-tint ink and renders an icon when provided", () => {
    render(
      <Note variant="warn" icon={<svg data-testid="note-icon" />}>
        Approaching your approved limit.
      </Note>
    );
    expect(screen.getByTestId("note-icon")).toBeTruthy();
    const note = screen.getByText("Approaching your approved limit.").closest("div")?.parentElement;
    expect(note?.classList.contains("bg-warn-soft")).toBe(true);
    // text-warn (#C9810C) on bg-warn-soft fails WCAG AA (~2.80:1); note-warn-ink (#8A5A06,
    // ~5.2:1) is the AA-compliant substitute.
    expect(note?.classList.contains("text-note-warn-ink")).toBe(true);
  });

  it("applies the dang variant's AA-compliant on-tint ink", () => {
    render(<Note variant="dang">Kill switch engaged.</Note>);
    const note = screen.getByText("Kill switch engaged.").closest("div")?.parentElement;
    expect(note?.classList.contains("bg-dang-soft")).toBe(true);
    // text-dang (#D33B2C) on bg-dang-soft fails WCAG AA (~3.98:1); note-dang-ink (#9E261A,
    // ~6.4:1) is the AA-compliant substitute.
    expect(note?.classList.contains("text-note-dang-ink")).toBe(true);
  });

  it("keeps the ever variant on the base `ever` token (already AA-compliant on ever-soft)", () => {
    render(<Note variant="ever">Autonomous action approved.</Note>);
    const note = screen.getByText("Autonomous action approved.").closest("div")?.parentElement;
    expect(note?.classList.contains("bg-ever-soft")).toBe(true);
    expect(note?.classList.contains("text-ever")).toBe(true);
  });

  it("omits the icon wrapper when no icon is passed", () => {
    render(<Note variant="dang">Kill switch engaged.</Note>);
    expect(document.querySelector("svg")).toBeNull();
  });
});
