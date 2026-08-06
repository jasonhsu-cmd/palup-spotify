import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ADR-0019 task 8 / R2-1 — the carry-over authorisation prompt copy. This string was mis-authored FOUR
// times (B1 and its three variants: the count/health-flag disclosure that leaks A's data to B on a shared
// browser, pre-authorisation, regardless of B's answer). The security review cleared exactly ONE string on
// the third pass. This test pins that string in the file an implementer copies from, and fails if any of the
// blocked disclosing phrasings reappear — a source-level guard, independent of the (inert) runtime path.

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../public/index.html"), "utf8");

describe("ADR-0019 R2-1 — carry-over prompt copy is the approved, disclosure-free string", () => {
  it("contains EXACTLY the one approved R2-1 string", () => {
    expect(html).toContain(
      "Were you using this device before without signing in? If so, I can carry that session's preferences over to your account.",
    );
  });

  it("does NOT resurrect any B1 disclosure phrasing (asserts nothing about the other session's data)", () => {
    // These phrasings each asserted the existence / count / health-status of A's notes to B before B
    // authorised anything — the leak the review blocked twice. None may appear anywhere in the widget.
    for (const forbidden of ["notes from then", "how many notes", "health-related", "some notes from"]) {
      expect(html, `blocked B1 disclosure phrase present: "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it("ships INERT — the prompt is flag-gated off (task 10 owns enabling it + wiring the carry-over)", () => {
    expect(html).toContain("CARRY_OVER_PROMPT_ENABLED = false");
  });
});
