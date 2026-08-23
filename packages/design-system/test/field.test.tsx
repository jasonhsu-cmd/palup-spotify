import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Field, Input, Textarea } from "../src/components/field";

describe("Field + Input/Textarea", () => {
  it("associates the label with the input via htmlFor/id and renders the help text", async () => {
    render(
      <Field label="Monthly spend cap" htmlFor="cap" help="Applies to ad spend and discounts.">
        <Input id="cap" defaultValue="4000" />
      </Field>
    );
    const input = screen.getByLabelText("Monthly spend cap") as HTMLInputElement;
    expect(input.value).toBe("4000");
    expect(screen.getByText("Applies to ad spend and discounts.")).toBeTruthy();
    await userEvent.clear(input);
    await userEvent.type(input, "5000");
    expect(input.value).toBe("5000");
  });

  it("renders a Textarea with the evergreen focus classes", () => {
    render(<Textarea aria-label="Rationale" />);
    const textarea = screen.getByLabelText("Rationale");
    expect(textarea.classList.contains("focus:border-ever")).toBe(true);
    expect(textarea.tagName).toBe("TEXTAREA");
  });
});
