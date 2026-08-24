import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ApiClient, LearnedInsight } from "../../app/api";
import { LearnedView } from "./LearnedView";

// W3 Task 8 — the console's Learned (Agent Memory) screen (spec §10). Matches
// palup-merchant-app.html #learned's layout/labels/copy but renders ONLY real API data: no
// fabricated total-facts/products-understood/segments/96%-voice-match tiles, no fabricated
// "memory health" percentages — the API this screen consumes has no such fields, so none are
// invented. The aggregate (cross-merchant) layer is OFF (AGGREGATE_LEARNING_ADR_ACCEPTED = false,
// zero live callers per the brief) — the screen states that honestly rather than showing fake
// aggregate data.

function fact(over: Partial<LearnedInsight> = {}): LearnedInsight {
  return {
    id: "l1",
    category: "customers",
    tier: "private",
    origin: "synthesized",
    text: "First-time buyers convert with a sample add-on",
    source: "orders",
    sampleSize: 250,
    confidence: "high",
    pinned: false,
    createdAt: "2026-08-24T00:00:00Z",
    updatedAt: "2026-08-24T00:00:00Z",
    ...over,
  };
}

function fakeApi(items: LearnedInsight[]): ApiClient {
  return {
    listLearned: vi.fn(async () => ({ items })),
    teachLearned: vi.fn(async (r) => ({ insight: fact({ id: "new", ...r }) })),
    pinLearned: vi.fn(async (id, pinned) => fact({ id, pinned })),
    deleteLearned: vi.fn(async () => ({ removed: true })),
    exportLearned: vi.fn(async () => ({
      tenantId: "t1",
      exportedAt: "2026-08-24T00:00:00Z",
      insights: items,
      portabilityNote: "You own your agent's private brain. A signed, portable export format is pending legal review.",
    })),
  } as unknown as ApiClient;
}

describe("LearnedView", () => {
  it("shows a loading state before the fetch resolves", () => {
    const api = fakeApi([fact()]);
    // never resolves within this test — asserts the loading state renders synchronously
    (api.listLearned as unknown as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    render(<LearnedView api={api} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("renders each insight's text, source, and confidence badge — no fabricated numbers", async () => {
    render(<LearnedView api={fakeApi([fact()])} />);
    expect(await screen.findByText(/first-time buyers convert/i)).toBeInTheDocument();
    expect(screen.getByText("orders")).toBeInTheDocument();
    expect(screen.getByText(/high/i)).toBeInTheDocument();
    expect(screen.queryByText("96%")).not.toBeInTheDocument(); // the mockup's fake voice-match tile is gone
  });

  it("shows an honest empty / still-measuring state when there is nothing yet", async () => {
    render(<LearnedView api={fakeApi([])} />);
    expect(await screen.findByText(/still measuring|nothing learned yet/i)).toBeInTheDocument();
  });

  it("shows the aggregate-network layer as coming-soon (OFF, pending legal/security)", async () => {
    render(<LearnedView api={fakeApi([fact()])} />);
    expect(await screen.findByText(/network insights.*coming soon|pending legal/i)).toBeInTheDocument();
  });

  it("pins an insight via the API", async () => {
    const api = fakeApi([fact({ id: "l1", pinned: false })]);
    render(<LearnedView api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: /pin/i }));
    expect(api.pinLearned).toHaveBeenCalledWith("l1", true);
  });

  it("deletes an insight via the API only after confirming", async () => {
    const api = fakeApi([fact({ id: "l1" })]);
    render(<LearnedView api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: /^delete$/i }));
    // clicking Delete once does NOT immediately call the API — a destructive act needs a confirm
    expect(api.deleteLearned).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(api.deleteLearned).toHaveBeenCalledWith("l1");
  });

  it("cancels a pending delete confirmation without calling the API", async () => {
    const api = fakeApi([fact({ id: "l1" })]);
    render(<LearnedView api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: /^delete$/i }));
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(api.deleteLearned).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^delete$/i })).toBeInTheDocument();
  });

  it("surfaces a dang error note when pin fails, instead of silently refetching", async () => {
    const api = fakeApi([fact({ id: "l1", pinned: false, text: "pin me" })]);
    (api.pinLearned as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    render(<LearnedView api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: /^pin$/i }));
    expect(await screen.findByText(/couldn't pin "pin me"/i)).toBeInTheDocument();
  });

  it("surfaces a dang error note when delete fails after confirmation", async () => {
    const api = fakeApi([fact({ id: "l1", text: "delete me" })]);
    (api.deleteLearned as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    render(<LearnedView api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: /^delete$/i }));
    await userEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(await screen.findByText(/couldn't delete "delete me"/i)).toBeInTheDocument();
  });

  it("filters the table by tab without fabricating any counts", async () => {
    const api = fakeApi([fact({ id: "l1", category: "customers", text: "customer insight text" }), fact({ id: "l2", category: "voice", text: "voice insight text" })]);
    render(<LearnedView api={api} />);
    expect(await screen.findByText(/customer insight text/i)).toBeInTheDocument();
    expect(screen.getByText(/voice insight text/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: /^voice$/i }));
    expect(screen.getByText(/voice insight text/i)).toBeInTheDocument();
    expect(screen.queryByText(/customer insight text/i)).not.toBeInTheDocument();
  });

  it("exports the merchant's private brain via the API and shows the export result honestly", async () => {
    const api = fakeApi([fact()]);
    render(<LearnedView api={api} />);
    await screen.findByText(/first-time buyers convert/i);
    await userEvent.click(screen.getByRole("button", { name: /export/i }));
    expect(api.exportLearned).toHaveBeenCalled();
    expect(await screen.findByText(/pending legal review/i)).toBeInTheDocument();
  });
});
