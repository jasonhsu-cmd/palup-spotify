import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toaster, useToast } from "../src/components/toast";

function Trigger({ message }: { message: string }) {
  const { toast } = useToast();
  return <button onClick={() => toast(message)}>Trigger</button>;
}

describe("Toaster / useToast", () => {
  it("shows a toast with the given message after toast() is called", async () => {
    render(
      <Toaster>
        <Trigger message="Settings saved" />
      </Toaster>
    );
    expect(screen.queryByText("Settings saved")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Trigger" }));
    expect(screen.getByText("Settings saved")).toBeTruthy();
  });

  it("supports firing more than one toast", async () => {
    render(
      <Toaster>
        <Trigger message="First" />
        <Trigger message="Second" />
      </Toaster>
    );
    const buttons = screen.getAllByRole("button", { name: "Trigger" });
    await userEvent.click(buttons[0]!);
    await userEvent.click(buttons[1]!);
    expect(screen.getByText("First")).toBeTruthy();
    expect(screen.getByText("Second")).toBeTruthy();
  });

  it("throws when useToast is called outside a Toaster", () => {
    function Broken() {
      useToast();
      return null;
    }
    // Suppress the expected React error-boundary console noise for this one assertion.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Broken />)).toThrow("useToast must be used within a <Toaster>");
    spy.mockRestore();
  });
});
