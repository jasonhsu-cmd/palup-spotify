import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ADR-0019 F-10 — after the carry-over ships (task 10) a shopper's guest facts may live in TWO namespaces
// (guest + account). A SIGNED-OUT forget can only reach the guest copy, so the widget must not claim TOTAL
// erasure in that case. This fix makes the confirmation honest, gated on CARRY_OVER_PROMPT_ENABLED so it is
// INERT (and the copy byte-identical to today) until task 10 flips the flag. This source-level guard pins
// both the wiring and the two strings without needing to execute the flag-off gated path.

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../public/index.html"), "utf8");

describe("ADR-0019 F-10 — the forget confirmation is honest about what a signed-out erase can reach", () => {
  it("keeps the total-erasure copy for the default (signed-in / pre-carry-over) path", () => {
    expect(html).toContain("Done — I've cleared what I remembered and started fresh.");
  });

  it("adds a device-scoped copy for the signed-out post-carry-over case that does NOT claim account erasure", () => {
    expect(html).toContain(
      "Done — I've cleared what I remembered on this device. If you carried preferences over to your account, sign in to clear those too.",
    );
    // The scoped copy must not assert the account copy was cleared (F-10's whole point).
    const scoped = "cleared what I remembered on this device. If you carried preferences over to your account, sign in to clear those too.";
    expect(scoped).not.toMatch(/cleared your account|deleted your account|account.*(cleared|deleted|erased)/i);
  });

  it("is gated on the carry-over flag AND signed-out state, so it stays inert until task 10", () => {
    // The honest branch fires only when the carry-over feature is live and no shopper token is present.
    expect(html).toContain("CARRY_OVER_PROMPT_ENABLED && !shopperToken");
    // And the feature is still shipped off (task 10 owns enabling it).
    expect(html).toContain("CARRY_OVER_PROMPT_ENABLED = false");
  });
});
