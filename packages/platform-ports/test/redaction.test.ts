import { describe, it, expect } from "vitest";
import { redactPII, createRedactingModelPort } from "../src/redaction.js";
import type { ModelPort, ModelRequest } from "../src/model-port.js";

describe("redactPII", () => {
  it("masks Luhn-valid payment cards (spaced, hyphenated, and bare)", () => {
    expect(redactPII("my card is 4111 1111 1111 1111 ok")).toBe("my card is [redacted-card] ok");
    expect(redactPII("4111-1111-1111-1111")).toBe("[redacted-card]");
    expect(redactPII("4111111111111111")).toBe("[redacted-card]");
  });

  it("masks US SSNs", () => {
    expect(redactPII("ssn 123-45-6789")).toBe("ssn [redacted-ssn]");
  });

  it("does NOT redact things the agent legitimately needs (email, phone, order/tracking numbers)", () => {
    // Email + phone are kept (support lookups need them).
    expect(redactPII("email jane@example.com phone 415-555-0100")).toBe("email jane@example.com phone 415-555-0100");
    // A long numeric order/tracking number that fails Luhn is not a card → left intact.
    expect(redactPII("order 1234567890123")).toBe("order 1234567890123");
  });

  it("is a no-op on empty/whitespace", () => {
    expect(redactPII("")).toBe("");
    expect(redactPII("hello there")).toBe("hello there");
  });
});

describe("createRedactingModelPort", () => {
  it("redacts user/assistant turns before the inner adapter sees them, but leaves the system prompt", async () => {
    const seen: ModelRequest[] = [];
    const inner: ModelPort = {
      async complete(req) {
        seen.push(req);
        return { text: "ok", model: "spy" };
      },
    };
    const port = createRedactingModelPort(inner);
    await port.complete({
      messages: [
        { role: "system", content: "You are a helpful assistant. Ref 4111 1111 1111 1111 in instructions." },
        { role: "user", content: "here is my card 4111 1111 1111 1111" },
        { role: "assistant", content: "your card 4111-1111-1111-1111 is on file" },
      ],
    });
    const req = seen[0];
    // System prompt untouched (trusted content).
    expect(req.messages[0].content).toContain("4111 1111 1111 1111");
    // Shopper + agent turns redacted — the provider never receives the card.
    expect(req.messages[1].content).toBe("here is my card [redacted-card]");
    expect(req.messages[2].content).toBe("your card [redacted-card] is on file");
  });
});
