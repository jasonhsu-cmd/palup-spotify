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

/** True if ANY 13–19 digit window of `digits` is Luhn-valid (catches a card embedded in a longer run). */
function hasCardWindow(digits: string): boolean {
  const n = digits.length;
  if (n < 13) return false;
  for (let len = 13; len <= 19; len++) {
    for (let i = 0; i + len <= n; i++) {
      if (luhnOk(digits.slice(i, i + len))) return true;
    }
  }
  return false;
}

export function redactPII(text: string): string {
  if (!text) return text;
  // NFKC folds fullwidth / Unicode digit variants (e.g. "４１１１") to ASCII so they can't evade matching.
  let out = text.normalize("NFKC");
  // Payment cards: a run of ASCII digits interleaved with common human separators (whitespace incl.
  // newlines, hyphen, dot, comma, non-breaking space, slash). Redact the whole run if any 13–19-digit
  // window is Luhn-valid — this defeats odd separators, line-split cards, and a card embedded in a
  // longer digit run. Non-adversarial ways people type cards must not slip through. The Luhn gate keeps
  // ordinary long numbers (order/tracking IDs) intact; a false negative would leak a card, so the gate
  // stays conservative. Separator/digit classes are disjoint, so the quantifier can't backtrack (no ReDoS).
  out = out.replace(/\d(?:[\s., /-]*\d){12,}/g, (m) => {
    const digits = m.replace(/\D/g, "");
    return hasCardWindow(digits) ? "[redacted-card]" : m;
  });
  // US SSN: NNN-NN-NNNN grouped by hyphen / space / dot. (Bare 9-digit SSNs are out of scope — matching
  // every 9-digit run would over-redact ZIP+4 / account / order numbers; documented gap.)
  out = out.replace(/\b\d{3}[-. ]\d{2}[-. ]\d{4}\b/g, "[redacted-ssn]");
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
