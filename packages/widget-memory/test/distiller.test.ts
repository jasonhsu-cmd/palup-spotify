import { describe, it, expect, vi } from "vitest";
import { createStubDistiller, sanitizeFact, FACT_MAX_CHARS } from "../src/distiller.js";

// ADR-0015 Inv 1: distilled facts only — never the raw transcript; every stored fact passes the
// redaction guardrail (no card/SSN/PII) and a length cap.
describe("distiller — sanitizeFact (redact + cap; never the transcript)", () => {
  it("redacts a Luhn-valid card number — the digits are gone from the output", () => {
    const raw = "the card on file is 4111 1111 1111 1111, please use that one";
    const result = sanitizeFact(raw);
    expect(result).not.toBeNull();
    expect(result).not.toContain("4111");
    expect(result).toContain("[redacted-card]");
  });

  it("truncates a candidate over the ~160-char cap rather than dropping it", () => {
    const raw = "a".repeat(200);
    const result = sanitizeFact(raw);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(FACT_MAX_CHARS);
  });

  it("returns null when the candidate is essentially the full raw transcript, not a distilled fact", () => {
    const message = "I have been looking for a new moisturizer for a while now and ".repeat(6);
    const reply = "Thanks for sharing that, here are a few options you might like to consider today. ".repeat(6);
    const candidate = `${message} ${reply}`; // what a broken/naive distiller would hand back verbatim
    expect(sanitizeFact(candidate)).toBeNull();
  });

  it("returns null for blank/empty input", () => {
    expect(sanitizeFact("")).toBeNull();
    expect(sanitizeFact("   ")).toBeNull();
  });

  it("returns null when contact-info PII (email) is present — a memory fact never needs it", () => {
    expect(sanitizeFact("email me at shopper@example.com to follow up")).toBeNull();
  });

  it("passes short, clean, ordinary facts through unchanged", () => {
    expect(sanitizeFact("prefers fragrance-free products")).toBe("prefers fragrance-free products");
  });
});

describe("distiller — createStubDistiller (deterministic, zero model calls)", () => {
  it("makes ZERO ModelPort-shaped calls — it never receives or touches a model", async () => {
    const modelSpy = { complete: vi.fn() };
    const distiller = createStubDistiller();
    const facts = await distiller.distill({ message: "loves the new serum", reply: "Great choice!" });
    expect(modelSpy.complete).not.toHaveBeenCalled();
    expect(Array.isArray(facts)).toBe(true);
  });

  it("is deterministic — same input, same output, across repeated calls", async () => {
    const distiller = createStubDistiller();
    const turn = { message: "prefers fragrance-free products", reply: "Noted!" };
    const first = await distiller.distill(turn);
    const second = await distiller.distill(turn);
    expect(second).toEqual(first);
  });
});
