import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PalupFloor, ProposalCategory, RulePreset } from "@palup/platform-ports";
import type { ApiClient } from "../../app/api";
import { KilledError } from "../../app/api";
import { PresetPicker } from "./PresetPicker";

const floors: Record<ProposalCategory, PalupFloor> = {
  discount: { maxAutoPct: 30, maxAutoUsd: 50, massSendRecipientFloor: 500 },
  ad_spend: { maxAutoPct: 100, maxAutoUsd: 500, maxAutoPeriodUsd: 5000, massSendRecipientFloor: 500 },
  refund: { maxAutoPct: 100, maxAutoUsd: 200, massSendRecipientFloor: 500 },
  campaign: { maxAutoPct: 100, maxAutoUsd: 100, massSendRecipientFloor: 500 },
  subscription: { maxAutoPct: 100, maxAutoUsd: 50, massSendRecipientFloor: 500 },
  autonomy_scope: { maxAutoPct: 0, maxAutoUsd: 0, massSendRecipientFloor: 500 },
};

const preset: RulePreset = {
  id: "day1-conservative",
  label: "Conservative (recommended)",
  vertical: "all",
  description: "Your agent answers shoppers automatically; discounts and refunds stay approval-gated.",
  envelope: { discount: { allowedAuto: false, maxPct: 10, stackable: false } },
};

type Api = Pick<ApiClient, "listRulePresets" | "previewRules" | "applyRulePreset">;

function fakeApi(over: Partial<Api> = {}): Api {
  return {
    listRulePresets: vi.fn(async () => ({ presets: [preset] })),
    previewRules: vi.fn(async () => ({ before: {}, after: {}, bigJump: false, effective: {}, capped: {} })),
    applyRulePreset: vi.fn(async () => ({ envelope: preset.envelope, bigJump: false })),
    ...over,
  };
}

describe("PresetPicker", () => {
  it("hides itself, honestly, when there are no presets — no placeholder", async () => {
    const api = fakeApi({ listRulePresets: vi.fn(async () => ({ presets: [] })) });
    render(<PresetPicker api={api} floors={floors} onApplied={vi.fn()} />);
    await waitFor(() => expect(api.listRulePresets).toHaveBeenCalled());
    expect(screen.queryByText(/preset/i)).not.toBeInTheDocument();
  });

  it("clicking Apply with none selected is a no-op — never previews or applies null", async () => {
    const api = fakeApi();
    render(<PresetPicker api={api} floors={floors} onApplied={vi.fn()} />);
    await screen.findByRole("button", { name: /apply preset/i });
    await userEvent.click(screen.getByRole("button", { name: /apply preset/i }));
    expect(api.previewRules).not.toHaveBeenCalled();
    expect(api.applyRulePreset).not.toHaveBeenCalled();
  });

  it("a non-big-jump preset applies immediately, without the confirm dialog", async () => {
    const onApplied = vi.fn();
    const api = fakeApi();
    render(<PresetPicker api={api} floors={floors} onApplied={onApplied} />);
    await userEvent.selectOptions(await screen.findByLabelText(/preset/i), "day1-conservative");
    await userEvent.click(screen.getByRole("button", { name: /apply preset/i }));

    await waitFor(() => expect(api.applyRulePreset).toHaveBeenCalledWith("day1-conservative"));
    expect(screen.queryByText(/giving your agent more room/i)).not.toBeInTheDocument();
    expect(onApplied).toHaveBeenCalledWith(preset.envelope);
  });

  it("a big-jump preset opens the confirm dialog first; only confirming adopts it", async () => {
    const onApplied = vi.fn();
    const after = { discount: { allowedAuto: true, maxPct: 10, stackable: false } };
    const api = fakeApi({
      previewRules: vi.fn(async () => ({ before: {}, after, bigJump: true, effective: {}, capped: {} })),
    });
    render(<PresetPicker api={api} floors={floors} onApplied={onApplied} />);
    await userEvent.selectOptions(await screen.findByLabelText(/preset/i), "day1-conservative");
    await userEvent.click(screen.getByRole("button", { name: /apply preset/i }));

    expect(await screen.findByText(/giving your agent more room/i)).toBeInTheDocument();
    expect(api.applyRulePreset).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /confirm/i }));
    await waitFor(() => expect(api.applyRulePreset).toHaveBeenCalledWith("day1-conservative"));
    expect(onApplied).toHaveBeenCalledWith(preset.envelope);
  });

  it("an error applying a preset surfaces via a dang Note, honestly", async () => {
    const api = fakeApi({
      applyRulePreset: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    render(<PresetPicker api={api} floors={floors} onApplied={vi.fn()} />);
    await userEvent.selectOptions(await screen.findByLabelText(/preset/i), "day1-conservative");
    await userEvent.click(screen.getByRole("button", { name: /apply preset/i }));

    expect(await screen.findByText(/network down/i)).toBeInTheDocument();
  });

  it("a KilledError while confirming a big-jump preset shows the halt message, not a success state", async () => {
    const after = { discount: { allowedAuto: true, maxPct: 10, stackable: false } };
    const api = fakeApi({
      previewRules: vi.fn(async () => ({ before: {}, after, bigJump: true, effective: {}, capped: {} })),
      applyRulePreset: vi.fn(async () => {
        throw new KilledError("safety pause");
      }),
    });
    const onApplied = vi.fn();
    render(<PresetPicker api={api} floors={floors} onApplied={onApplied} />);
    await userEvent.selectOptions(await screen.findByLabelText(/preset/i), "day1-conservative");
    await userEvent.click(screen.getByRole("button", { name: /apply preset/i }));
    await screen.findByText(/giving your agent more room/i);

    await userEvent.click(screen.getByRole("button", { name: /confirm/i }));

    expect(await screen.findByText(/agents are halted/i)).toBeInTheDocument();
    expect(onApplied).not.toHaveBeenCalled();
  });
});
