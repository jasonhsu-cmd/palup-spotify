import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from "../src/components/dialog";
import { Button } from "../src/components/button";

function KillSwitchConfirm() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="danger">Kill switch</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Halt all autonomous actions?</DialogTitle>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button variant="danger">Confirm halt</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

describe("Dialog", () => {
  it("is closed until the trigger is clicked, then shows the title", async () => {
    render(<KillSwitchConfirm />);
    expect(screen.queryByText("Halt all autonomous actions?")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Kill switch" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Halt all autonomous actions?")).toBeTruthy();
  });

  it("closes when DialogClose is clicked", async () => {
    render(<KillSwitchConfirm />);
    await userEvent.click(screen.getByRole("button", { name: "Kill switch" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is modal, moves focus inside on open, and closes on Escape (governance a11y)", async () => {
    render(<KillSwitchConfirm />);
    await userEvent.click(screen.getByRole("button", { name: "Kill switch" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    // Radix moves focus into the content on open (focus trap); the confirm button is inside it.
    expect(dialog.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
