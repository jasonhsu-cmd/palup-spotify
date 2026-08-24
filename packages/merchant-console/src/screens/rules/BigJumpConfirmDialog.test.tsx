import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PalupFloor, ProposalCategory } from "@palup/platform-ports";
import { BigJumpConfirmDialog } from "./BigJumpConfirmDialog";

const floors: Record<ProposalCategory, PalupFloor> = {
  discount: { maxAutoPct: 30, maxAutoUsd: 50, massSendRecipientFloor: 500 },
  ad_spend: { maxAutoPct: 100, maxAutoUsd: 500, maxAutoPeriodUsd: 5000, massSendRecipientFloor: 500 },
  refund: { maxAutoPct: 100, maxAutoUsd: 200, massSendRecipientFloor: 500 },
  campaign: { maxAutoPct: 100, maxAutoUsd: 100, massSendRecipientFloor: 500 },
  subscription: { maxAutoPct: 100, maxAutoUsd: 50, massSendRecipientFloor: 500 },
  autonomy_scope: { maxAutoPct: 0, maxAutoUsd: 0, massSendRecipientFloor: 500 },
};

describe("BigJumpConfirmDialog", () => {
  it("states the EFFECTIVE 'up to X' sentence for the changed category, never the raw previewed value", () => {
    render(
      <BigJumpConfirmDialog
        open
        after={{ discount: { allowedAuto: true, maxPct: 90, stackable: false } }} // above the 30% floor
        floors={floors}
        changed={["discount"]}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/you're giving your agent more room/i)).toBeInTheDocument();
    expect(screen.getByText(/up to 30%/i)).toBeInTheDocument();
    expect(screen.queryByText(/up to 90%/i)).not.toBeInTheDocument();
  });

  it("renders one sentence per changed category", () => {
    render(
      <BigJumpConfirmDialog
        open
        after={{
          discount: { allowedAuto: true, maxPct: 20, stackable: false },
          refund: { allowedAuto: true, maxUsd: 150, priceMatchMaxUsd: 50 },
        }}
        floors={floors}
        changed={["discount", "refund"]}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/^discounts$/i)).toBeInTheDocument();
    expect(screen.getByText(/^refunds & price-match$/i)).toBeInTheDocument();
    expect(screen.getByText(/up to 20%/i)).toBeInTheDocument();
    expect(screen.getByText(/auto-refund up to \$150/i)).toBeInTheDocument();
  });

  it("Confirm calls onConfirm", async () => {
    const onConfirm = vi.fn();
    render(
      <BigJumpConfirmDialog
        open
        after={{ discount: { allowedAuto: true, maxPct: 20, stackable: false } }}
        floors={floors}
        changed={["discount"]}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("Cancel calls onCancel and never onConfirm", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <BigJumpConfirmDialog
        open
        after={{ discount: { allowedAuto: true, maxPct: 20, stackable: false } }}
        floors={floors}
        changed={["discount"]}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("renders nothing when closed", () => {
    render(
      <BigJumpConfirmDialog
        open={false}
        after={{}}
        floors={floors}
        changed={[]}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByText(/giving your agent more room/i)).not.toBeInTheDocument();
  });

  it("surfaces a passed-in error (e.g. a Kill Switch halt) via a dang Note", () => {
    render(
      <BigJumpConfirmDialog
        open
        after={{ discount: { allowedAuto: true, maxPct: 20, stackable: false } }}
        floors={floors}
        changed={["discount"]}
        error="Agents are halted (Kill Switch armed) — rules were not changed"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/agents are halted/i)).toBeInTheDocument();
  });
});
