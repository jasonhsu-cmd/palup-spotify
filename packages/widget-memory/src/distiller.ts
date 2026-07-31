import { redactPII } from "@palup/platform-ports";

// ADR-0015 Inv 1: distilled facts only — never persist the raw transcript; every stored fact passes
// the redaction guardrail and a length cap. `FactDistiller` is the governed extraction step (Inv 11:
// "the extraction prompt... [is] a governed behavior with their own eval + review") — a real
// LLM-backed implementation is a later, separately-reviewed PR. `createStubDistiller` here is a
// deterministic, model-free placeholder that only exists to exercise the pipeline end-to-end in this
// inert slice; it never calls a `ModelPort`.

/** Extracts 0-N short candidate facts from one conversational turn. Real implementations call the
 * model port (governed, own eval); `createStubDistiller` below never does. */
export interface FactDistiller {
  distill(turn: { message: string; reply: string }): Promise<string[]>;
}

/** The hard cap on a stored fact's length (ADR-0015 Inv 1: "short, minimal preference/observation
 * records"). ~160 chars per the spec — long enough for a real sentence, short enough that it can never
 * be a multi-turn transcript. */
export const FACT_MAX_CHARS = 160;

// Content markedly longer than a short distilled fact is treated as transcript-like and REJECTED
// outright rather than silently truncated to FACT_MAX_CHARS — truncating a whole transcript would still
// leak a large chunk of raw shopper content into storage (Inv 1). 3x the cap is a generous allowance
// for a genuinely long single fact while still catching anything transcript-shaped.
const TRANSCRIPT_LIKE_CHARS = FACT_MAX_CHARS * 3;

// redactPII (packages/platform-ports/src/redaction.ts) deliberately leaves email/phone alone on the
// /chat path (the agent legitimately needs them for support lookups there) — but a MEMORY fact is a
// short preference/observation record that never legitimately needs contact info, so this module adds
// its own narrow, format-specific contact-info check on top of redactPII's card/SSN redaction.
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[a-z]{2,}/i;
const PHONE_PATTERN = /\(\d{3}\)\s?\d{3}[-.\s]?\d{4}|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b|\+\d{1,3}[\s-]\d{6,}/;

/**
 * Runs the redaction guardrail (`redactPII` — cards/SSNs) over a candidate fact, rejects it outright if
 * it's transcript-shaped or still carries contact-info PII redactPII doesn't cover, then caps its
 * length. Returns `null` (never persist) rather than a partially-safe string when the candidate isn't a
 * genuine short fact.
 */
export function sanitizeFact(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > TRANSCRIPT_LIKE_CHARS) return null; // transcript-shaped, not a distilled fact

  const redacted = redactPII(trimmed);
  if (EMAIL_PATTERN.test(redacted) || PHONE_PATTERN.test(redacted)) return null; // contact-info PII

  return redacted.length > FACT_MAX_CHARS ? redacted.slice(0, FACT_MAX_CHARS) : redacted;
}

/**
 * Deterministic, model-free placeholder `FactDistiller` (T5 — no real extraction model is wired in
 * this inert slice). It hands the shopper's own message through `sanitizeFact` as a single crude
 * candidate, purely so the rest of the pipeline (classification, consent gating, storage, recall) can
 * be exercised end-to-end. A governed, LLM-backed distiller (its own eval + review, ADR-0015 Inv 11)
 * replaces this in a later PR — this stub makes NO network/model call of any kind.
 */
export function createStubDistiller(): FactDistiller {
  return {
    async distill(turn) {
      const candidate = sanitizeFact(turn.message);
      return candidate ? [candidate] : [];
    },
  };
}
