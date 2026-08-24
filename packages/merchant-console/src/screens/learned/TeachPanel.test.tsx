import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ApiClient, LearnedInsight, TeachRequest } from "../../app/api";
import { ApiError } from "../../app/api";
import { TeachPanel } from "./TeachPanel";

// W3 Task 8 — the "Teach your agent" panel (spec §10, matches palup-merchant-app.html #learned's
// side card). Consumes only `teachLearned` (Pick<ApiClient, "teachLearned">); the safety-floor
// rejection (a teach that would loosen a safety-critical guardrail, isSafetyFloorViolation) comes
// back as a 400 → typed ApiError from the real client (task-7-report.md, api.ts's generic
// `!res.ok` branch) — this panel must render that as a clear inline message, never crash.

function fact(over: Partial<LearnedInsight> = {}): LearnedInsight {
  return {
    id: "new",
    category: "voice",
    tier: "private",
    origin: "merchant_taught",
    text: "Never use exclamation marks in apologies",
    source: "merchant_taught",
    sampleSize: 0,
    confidence: "high",
    pinned: false,
    createdAt: "2026-08-24T00:00:00Z",
    updatedAt: "2026-08-24T00:00:00Z",
    ...over,
  };
}

describe("TeachPanel", () => {
  it("submits the category + text and calls teachLearned", async () => {
    const teachLearned = vi.fn(async (req: TeachRequest) => ({ insight: fact({ ...req }) }));
    const onTaught = vi.fn();
    render(<TeachPanel api={{ teachLearned } as unknown as Pick<ApiClient, "teachLearned">} onTaught={onTaught} />);

    await userEvent.selectOptions(screen.getByLabelText(/category/i), "voice");
    await userEvent.type(screen.getByLabelText(/teach your agent/i), "Never use exclamation marks in apologies");
    await userEvent.click(screen.getByRole("button", { name: /add to memory/i }));

    expect(teachLearned).toHaveBeenCalledWith(
      expect.objectContaining({ category: "voice", text: "Never use exclamation marks in apologies" }),
    );
    expect(onTaught).toHaveBeenCalled();
  });

  it("surfaces the guardrail + stance inputs only when teaching a policy", async () => {
    const teachLearned = vi.fn(async (req: TeachRequest) => ({ insight: fact({ ...req }) }));
    render(<TeachPanel api={{ teachLearned } as unknown as Pick<ApiClient, "teachLearned">} />);

    expect(screen.queryByLabelText(/guardrail/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/stance/i)).not.toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText(/category/i), "policies");

    expect(screen.getByLabelText(/guardrail/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/stance/i)).toBeInTheDocument();
  });

  it("disables submit when the text is empty", async () => {
    const teachLearned = vi.fn(async (req: TeachRequest) => ({ insight: fact({ ...req }) }));
    render(<TeachPanel api={{ teachLearned } as unknown as Pick<ApiClient, "teachLearned">} />);

    expect(screen.getByRole("button", { name: /add to memory/i })).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/teach your agent/i), "  ");
    expect(screen.getByRole("button", { name: /add to memory/i })).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/teach your agent/i), "a real fact");
    expect(screen.getByRole("button", { name: /add to memory/i })).not.toBeDisabled();
  });

  it("clears the form and reports success after a successful teach", async () => {
    const teachLearned = vi.fn(async (req: TeachRequest) => ({ insight: fact({ ...req }) }));
    render(<TeachPanel api={{ teachLearned } as unknown as Pick<ApiClient, "teachLearned">} />);

    await userEvent.type(screen.getByLabelText(/teach your agent/i), "a real fact");
    await userEvent.click(screen.getByRole("button", { name: /add to memory/i }));

    expect(await screen.findByText(/added to memory/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/teach your agent/i)).toHaveValue("");
  });

  it("surfaces a safety-floor rejection (400) as a clear error, not a crash", async () => {
    const teachLearned = vi.fn(async () => {
      throw new ApiError(400, "safety floor: a safety-critical guardrail can be tightened but not loosened");
    });
    render(<TeachPanel api={{ teachLearned } as unknown as Pick<ApiClient, "teachLearned">} />);

    await userEvent.selectOptions(screen.getByLabelText(/category/i), "policies");
    await userEvent.type(screen.getByLabelText(/teach your agent/i), "loosen the refund cap for VIPs");
    await userEvent.selectOptions(screen.getByLabelText(/stance/i), "loosen");
    await userEvent.click(screen.getByRole("button", { name: /add to memory/i }));

    expect(await screen.findByText(/safety floor/i)).toBeInTheDocument();
    // the text the merchant typed is preserved — a rejection never silently wipes their input
    expect(screen.getByLabelText(/teach your agent/i)).toHaveValue("loosen the refund cap for VIPs");
  });
});
