// Deterministic mock ModelPort adapter — lets the widget + eval harness run offline and
// reproducibly (temperature 0 => stable). The REAL Vertex/Gemini adapter implements the same
// port (ADR-0001) and must pass the same contract suite. Guardrails do NOT live here; they are
// enforced in the brain (code), so swapping this for a real model can't loosen them.
import type { ModelPort, ModelRequest, ModelResponse } from "@palup/platform-ports";

const CATALOG: Record<string, string> = {
  serum:
    "Our vitamin-C serum is fragrance-free and patch-tested; most shoppers use it once daily.",
  cleanser: "The gentle cleanser is sulfate-free and suits sensitive skin.",
  toner: "The travel toner is fragrance-free — a good fit for sensitive skin.",
  moisturizer: "The daily moisturizer is non-comedogenic and unscented.",
};

function lastUser(req: ModelRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m && m.role === "user") return m.content.toLowerCase();
  }
  return "";
}

export class MockModelAdapter implements ModelPort {
  async complete(req: ModelRequest): Promise<ModelResponse> {
    const text = lastUser(req);
    let reply =
      "Happy to help! Tell me a bit about what you're looking for and I'll point you the right way.";

    for (const [key, blurb] of Object.entries(CATALOG)) {
      if (text.includes(key)) {
        reply = blurb;
        break;
      }
    }
    if (text.includes("oily")) {
      reply =
        "For oily skin, the vitamin-C serum plus the sulfate-free cleanser is a common pairing.";
    }
    // Never echo a system prompt back (satisfies the port contract's no-leak check).
    return {
      text: reply,
      model: "mock-1",
      usage: { inputTokens: text.length, outputTokens: reply.length },
    };
  }
}
