import { describe, it, expect } from "vitest";
import { suggestedChipsWireField } from "../src/recommendation-telemetry.js";

// Pillar 3 (opener) — the /chat wire field for the opener's tappable quick-reply CHIPS. Like the E3
// product-card fields, it contributes NO key unless the decision actually carried chips, so a turn that
// mints none (every turn while PROACTIVE_OPENER is off) is byte-identical to before this seam existed.

describe("Pillar 3 — suggestedChipsWireField (opener chips wire, byte-identical when absent)", () => {
  it("contributes NO key when the decision carries no chips (flag-off byte-identical)", () => {
    expect(suggestedChipsWireField({})).toEqual({});
    expect(suggestedChipsWireField({ suggestedChips: undefined })).toEqual({});
    expect(suggestedChipsWireField({ suggestedChips: [] })).toEqual({});
    // the KEY must be absent (not present-with-empty-value), so JSON.stringify drops it entirely
    expect(Object.prototype.hasOwnProperty.call(suggestedChipsWireField({ suggestedChips: [] }), "suggestedChips")).toBe(false);
  });

  it("passes the chips through unchanged when the opener minted them (closed action enum, code-owned labels)", () => {
    const chips = [
      { label: "Find my match", action: "find_my_match" as const },
      { label: "Bestsellers", action: "bestsellers" as const },
      { label: "New here?", action: "new_here" as const },
    ];
    expect(suggestedChipsWireField({ suggestedChips: chips })).toEqual({ suggestedChips: chips });
  });
});
