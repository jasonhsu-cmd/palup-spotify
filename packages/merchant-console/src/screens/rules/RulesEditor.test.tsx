import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ApiClient } from "../../app/api";
import { KilledError } from "../../app/api";
import { RulesEditor } from "./RulesEditor";

const floors = {
  discount: { maxAutoPct: 30, maxAutoUsd: 50, massSendRecipientFloor: 500 },
  ad_spend: { maxAutoPct: 100, maxAutoUsd: 500, maxAutoPeriodUsd: 5000, massSendRecipientFloor: 500 },
  refund: { maxAutoPct: 100, maxAutoUsd: 200, massSendRecipientFloor: 500 },
  campaign: { maxAutoPct: 100, maxAutoUsd: 100, massSendRecipientFloor: 500 },
  subscription: { maxAutoPct: 100, maxAutoUsd: 50, massSendRecipientFloor: 500 },
  autonomy_scope: { maxAutoPct: 0, maxAutoUsd: 0, massSendRecipientFloor: 500 },
} as const;

function fakeApi(over: Partial<ApiClient> = {}): ApiClient {
  return {
    getRules: vi.fn(async () => ({ envelope: { discount: { allowedAuto: false, maxPct: 10, stackable: false } } })),
    getFloors: vi.fn(async () => ({ floors: floors as any })),
    listRulePresets: vi.fn(async () => ({ presets: [] })),
    putRules: vi.fn(async () => ({ envelope: {}, bigJump: false })),
    previewRules: vi.fn(async () => ({ before: {}, after: {}, bigJump: false })),
    applyRulePreset: vi.fn(async () => ({ envelope: {}, bigJump: false })),
    ...over,
  } as unknown as ApiClient;
}

describe("RulesEditor", () => {
  it("renders the page header + the ever-note explainer from the mockup", async () => {
    render(<RulesEditor api={fakeApi()} />);
    expect(await screen.findByRole("heading", { name: /automation rules/i })).toBeInTheDocument();
    expect(screen.getByText(/anything above a rule's limit still comes to your approval center/i)).toBeInTheDocument();
  });

  it("renders a card per money category showing the PalUp ceiling (three-layer)", async () => {
    render(<RulesEditor api={fakeApi()} />);
    expect(await screen.findByText(/discount/i)).toBeInTheDocument();
    expect(screen.getByText(/PalUp caps this at 30%/i)).toBeInTheDocument(); // inviolable floor surfaced
  });

  it("shows an honest error state when the load fails — no fabricated values", async () => {
    const api = fakeApi();
    (api.getRules as any) = vi.fn(async () => { throw new Error("boom"); });
    render(<RulesEditor api={api} />);
    expect(await screen.findByText(/couldn't load your rules/i)).toBeInTheDocument();
  });

  // The Task-5-ruling honesty requirement: a merchant value stored ABOVE the PalUp floor must
  // never be shown as if it were the real effective auto-limit. The screen must show BOTH the raw
  // merchant setting (in the editable input) AND a clear "capped" flag naming the actual floor —
  // never just the raw 90% alone (which would mislead: the agent can never actually act past 30%).
  it("flags a merchant value above the floor with the effective clamped value, not just the raw setting", async () => {
    const api = fakeApi({
      getRules: vi.fn(async () => ({
        envelope: { discount: { allowedAuto: true, maxPct: 90, stackable: false } },
      })),
    });
    render(<RulesEditor api={api} />);
    await screen.findByRole("heading", { name: /discounts/i });

    // The raw merchant value is still visible (controlled input, no write-time clamping) …
    expect(screen.getByLabelText(/max % off/i)).toHaveValue(90);
    // … but the effective, clamped auto-grant sentence never claims more than the floor …
    expect(screen.getByText(/up to 30%/i)).toBeInTheDocument();
    expect(screen.queryByText(/up to 90%/i)).not.toBeInTheDocument();
    // … and an explicit capped flag names both the floor and the merchant's own (inert) setting.
    expect(screen.getByText(/capped at 30% by palup's floor/i)).toBeInTheDocument();
    expect(screen.getByText(/your setting of 90% won't take effect/i)).toBeInTheDocument();
  });

  it("a valid edit calls putRules with the changed category", async () => {
    const putRules = vi.fn(async () => ({
      envelope: { discount: { allowedAuto: true, maxPct: 20, stackable: false } },
      bigJump: false,
    }));
    const api = fakeApi({ putRules });
    render(<RulesEditor api={api} />);
    await screen.findByRole("heading", { name: /discounts/i });

    await userEvent.clear(screen.getByLabelText(/max % off/i));
    await userEvent.type(screen.getByLabelText(/max % off/i), "20");
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(putRules).toHaveBeenCalledTimes(1));
    expect(putRules).toHaveBeenCalledWith({ discount: expect.objectContaining({ maxPct: 20 }) });
    // the post-save confirmation states the effective value that now applies (appears at least
    // once — the save-confirmation Note and the card's own derived sentence may both say it).
    await waitFor(() => expect(screen.getAllByText(/up to 20%/i).length).toBeGreaterThan(0));
  });

  it("an error on save surfaces via a dang Note, honestly — no silent failure", async () => {
    const putRules = vi.fn(async () => { throw new Error("network down"); });
    const api = fakeApi({ putRules });
    render(<RulesEditor api={api} />);
    await screen.findByRole("heading", { name: /discounts/i });

    await userEvent.clear(screen.getByLabelText(/max % off/i));
    await userEvent.type(screen.getByLabelText(/max % off/i), "5");
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

    expect(await screen.findByText(/network down/i)).toBeInTheDocument();
  });

  // Task 10 — the big-jump CONFIRM dialog (spec's big-jump-confirm requirement): a merchant making
  // a large rules change must see the EFFECTIVE "up to X" values before it applies, and putRules
  // must never fire until they explicitly confirm.
  it("a big-jump save opens the confirm dialog with EFFECTIVE values and does not call putRules until confirmed", async () => {
    const putRules = vi.fn(async () => ({
      envelope: { discount: { allowedAuto: true, maxPct: 20, stackable: false } },
      bigJump: true,
    }));
    const previewRules = vi.fn(async () => ({
      before: {},
      after: { discount: { allowedAuto: true, maxPct: 90, stackable: false } }, // above the 30% floor
      bigJump: true,
      effective: {},
      capped: {},
    }));
    const api = fakeApi({ putRules, previewRules });
    render(<RulesEditor api={api} />);
    await screen.findByRole("heading", { name: /discounts/i });

    await userEvent.clear(screen.getByLabelText(/max % off/i));
    await userEvent.type(screen.getByLabelText(/max % off/i), "20");
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

    expect(await screen.findByText(/giving your agent more room/i)).toBeInTheDocument();
    expect(putRules).not.toHaveBeenCalled();
    // the dialog states the EFFECTIVE, floor-clamped value (30%) — never the raw 90% previewed value
    expect(screen.getByText(/up to 30%/i)).toBeInTheDocument();
    expect(screen.queryByText(/up to 90%/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /confirm/i }));

    await waitFor(() =>
      expect(putRules).toHaveBeenCalledWith({ discount: expect.objectContaining({ maxPct: 20 }) }),
    );
    await waitFor(() => expect(screen.queryByText(/giving your agent more room/i)).not.toBeInTheDocument());
    expect(screen.getByLabelText(/max % off/i)).toHaveValue(20); // dirty cleared — shows the saved value
  });

  it("cancelling the big-jump confirm never calls putRules and leaves the edit dirty", async () => {
    const putRules = vi.fn(async () => ({ envelope: {}, bigJump: false }));
    const previewRules = vi.fn(async () => ({
      before: {},
      after: { discount: { allowedAuto: true, maxPct: 90, stackable: false } },
      bigJump: true,
      effective: {},
      capped: {},
    }));
    const api = fakeApi({ putRules, previewRules });
    render(<RulesEditor api={api} />);
    await screen.findByRole("heading", { name: /discounts/i });

    await userEvent.clear(screen.getByLabelText(/max % off/i));
    await userEvent.type(screen.getByLabelText(/max % off/i), "20");
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await screen.findByText(/giving your agent more room/i);

    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(putRules).not.toHaveBeenCalled();
    expect(screen.queryByText(/giving your agent more room/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/max % off/i)).toHaveValue(20); // the typed edit is still there
  });

  it("a non-big-jump save calls putRules directly — sovereign + instant, no dialog", async () => {
    const putRules = vi.fn(async () => ({
      envelope: { discount: { allowedAuto: true, maxPct: 20, stackable: false } },
      bigJump: false,
    }));
    const previewRules = vi.fn(async () => ({ before: {}, after: {}, bigJump: false, effective: {}, capped: {} }));
    const api = fakeApi({ putRules, previewRules });
    render(<RulesEditor api={api} />);
    await screen.findByRole("heading", { name: /discounts/i });

    await userEvent.clear(screen.getByLabelText(/max % off/i));
    await userEvent.type(screen.getByLabelText(/max % off/i), "20");
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(putRules).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/giving your agent more room/i)).not.toBeInTheDocument();
  });

  it("putRules throwing KilledError shows the halt message, not a success note", async () => {
    const putRules = vi.fn(async () => {
      throw new KilledError("safety pause");
    });
    const api = fakeApi({ putRules });
    render(<RulesEditor api={api} />);
    await screen.findByRole("heading", { name: /discounts/i });

    await userEvent.clear(screen.getByLabelText(/max % off/i));
    await userEvent.type(screen.getByLabelText(/max % off/i), "20");
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

    expect(await screen.findByText(/agents are halted \(kill switch armed\) — rules were not changed/i)).toBeInTheDocument();
    expect(screen.queryByText(/^saved\./i)).not.toBeInTheDocument();
  });
});
