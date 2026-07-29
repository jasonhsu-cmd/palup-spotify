import type { ModelPort, ModelRequest, ModelResponse } from "./model-port.js";

// PII redaction guardrail (security-data-path §3). A shopper can paste highly sensitive data into a
// chat (a payment card, an SSN) that the agent NEVER needs to see or store. This redacts that class of
// PII at two boundaries: (1) BEFORE it reaches the model (so it can't be echoed, memorized, or logged
// by the provider), and (2) before it is written to the traffic log at rest.
//
// Scope is deliberately narrow — only the "never legitimately needed" identifiers (payment cards, US
// SSNs). Emails / phone numbers are intentionally NOT redacted here: the agent legitimately needs them
// for support lookups ("what's the email on your order?"), so blanket-masking them would break the
// product. Minimizing email/phone specifically in the analytics traffic log (where they aren't needed)
// is a tracked follow-up (T9 note). Card matching is Luhn-gated so long order/tracking numbers aren't
// falsely redacted; false-negatives fail toward leaking a card, so the gate stays conservative.

/** Luhn checksum — distinguishes a real card number from an arbitrary long digit run. */
function luhnOk(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function redactPII(text: string): string {
  if (!text) return text;
  let out = text;
  // Payment-card-like: 13–19 digits, optionally single-separated by spaces/hyphens. Redact ONLY when
  // Luhn-valid so a 13+ digit order/tracking number isn't mistaken for a card.
  out = out.replace(/\b\d(?:[ -]?\d){12,18}\b/g, (m) => {
    const digits = m.replace(/[ -]/g, "");
    return luhnOk(digits) ? "[redacted-card]" : m;
  });
  // US SSN: NNN-NN-NNNN (hyphen or space grouped).
  out = out.replace(/\b\d{3}[- ]\d{2}[- ]\d{4}\b/g, "[redacted-ssn]");
  return out;
}

/**
 * Wrap a ModelPort so shopper-turn content is PII-redacted before it reaches the provider. The system
 * prompt (role "system") is trusted PalUp content and is left untouched — redacting it could corrupt
 * instructions. Everything else (user + prior assistant turns) is redacted.
 */
export function createRedactingModelPort(inner: ModelPort): ModelPort {
  return {
    async complete(req: ModelRequest): Promise<ModelResponse> {
      const messages = req.messages.map((m) =>
        m.role === "system" ? m : { ...m, content: redactPII(m.content) },
      );
      return inner.complete({ ...req, messages });
    },
  };
}
