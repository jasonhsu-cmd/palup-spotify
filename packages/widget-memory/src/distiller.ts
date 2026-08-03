import { redactPII } from "@palup/platform-ports";
import type { ModelPort } from "@palup/platform-ports";
import type { Disposition, DispositionAxis } from "./disposition.js";

// ADR-0015 Inv 1: distilled facts only — never persist the raw transcript; every stored fact passes
// the redaction guardrail and a length cap. `FactDistiller` is the governed extraction step (Inv 11:
// "the extraction prompt... [is] a governed behavior with their own eval + review") — a real
// LLM-backed implementation is a later, separately-reviewed PR. `createStubDistiller` here is a
// deterministic, model-free placeholder that only exists to exercise the pipeline end-to-end in this
// inert slice; it never calls a `ModelPort`.

/** One distilled candidate: the fact text, plus an OPTIONAL validated disposition (PR-8 — the
 * previously-discarded `disposition` a real distiller extracts alongside a fact, now surfaced so
 * `service.ts` can store it on `FactMetadata.disposition` / return it on `RecalledFact.disposition`). */
export interface DistilledCandidate {
  text: string;
  disposition?: Disposition;
}

/** Extracts 0-N short candidate facts (each optionally carrying a validated disposition) from one
 * conversational turn. Real implementations call the model port (governed, own eval);
 * `createStubDistiller` below never does. */
export interface FactDistiller {
  distill(turn: { message: string; reply: string }): Promise<DistilledCandidate[]>;
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
      return candidate ? [{ text: candidate }] : [];
    },
  };
}

// PR-6 — the real, model-backed `FactDistiller` (ADR-0015 Inv 11: extraction is a GOVERNED behavior,
// with its own eval + review; this module IS that review boundary). It stays fully inert exactly like
// the stub above: nothing here writes anywhere, and (per service.ts) it is never even CALLED while the
// flag.ts double gate is off. Everything downstream of the candidate strings this returns — redaction/
// length-capping (`sanitizeFact`), sensitivity classification (`classifyFact`), consent-gating
// (`decideMemoryWrite`), and TTL (`ttlForClass`) — is the EXISTING service.ts pipeline, reused
// UNCHANGED; this module does not reimplement any of it.
//
// The model is asked for a small JSON array of `{ text, disposition? }` candidates. `disposition` is
// OPTIONAL per candidate — most facts are plain preferences with no disposition attached. When one IS
// attached, the response schema constrains `provenance` to the enum `"stated" | "observed"` (no
// "inferred" member — mirrors disposition.ts's own narrow-only union), and the prompt explicitly
// forbids demographic, psychographic, and willingness-to-pay/budget-inference extraction. Because model
// JSON output is never type-checked, this module ALSO re-validates every candidate's disposition shape
// at runtime and REJECTS THE WHOLE CANDIDATE (text included, not just the disposition) if its
// disposition doesn't have a valid axis/value/confidence, or a provenance that isn't exactly "stated" or
// "observed" — a candidate carrying a suspect disposition is not trusted at all, fairness-structural.

/** Dependencies for `createModelDistiller` — a `ModelPort`, never a provider SDK (ADR-0001). */
export interface ModelDistillerDeps {
  model: ModelPort;
}

const DISPOSITION_AXES: readonly DispositionAxis[] = ["role", "style", "communication", "budget_stated"];

// Structured-outputs schema (mirrors judge/model-judge.ts's pattern): adapters that support
// `responseSchema` (e.g. Anthropic `output_config.format`) enforce this shape at the provider; adapters
// that don't simply ignore it, so the runtime revalidation below is load-bearing either way.
const DISTILL_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string" },
          disposition: {
            type: "object",
            additionalProperties: false,
            properties: {
              axis: { type: "string", enum: DISPOSITION_AXES as unknown as string[] },
              value: { type: "string" },
              // NO "inferred" member — fairness structural (disposition.ts).
              provenance: { type: "string", enum: ["stated", "observed"] },
              confidence: { type: "number" },
              sourceQuote: { type: "string" },
            },
            required: ["axis", "value", "provenance", "confidence"],
          },
        },
        required: ["text"],
      },
    },
  },
  required: ["facts"],
} as const;

const DISTILL_SYSTEM_PROMPT = `You extract short, durable SHOPPER PREFERENCE/STYLE facts from ONE
conversation turn, for consent-gated memory. Follow these rules exactly:

1. Extract 0-N short facts (one short sentence each) — NEVER the full transcript, NEVER a summary of
   the whole conversation.
2. NEVER extract demographic facts (age, gender, race/ethnicity, income, occupation, location) or
   psychographic facts (personality traits, values, lifestyle profiling). These are always out of
   scope, no matter how confident you are.
3. NEVER infer, guess, or estimate a shopper's willingness-to-pay, budget, or price sensitivity. Only a
   budget the shopper EXPLICITLY stated in their own words (e.g. "keep it under $50") may be recorded,
   and only with provenance "stated" — never estimate one from tone, product choice, or anything else.
4. A fact MAY optionally carry a "disposition" — a durable style/preference signal — but ONLY when you
   can honestly attach a provenance:
   - "stated": the shopper said this directly, in their own words.
   - "observed": a concrete, literal behavior in THIS turn (e.g. asked for ingredient names, asked
     "what's on sale").
   NEVER attach any other provenance value, and NEVER attach a disposition guessed/inferred from tone,
   wording style, or an unstated assumption. When in doubt, omit "disposition" entirely.
5. Output ONLY this JSON shape, nothing else — no prose, no markdown fences:
   {"facts":[{"text":"<short fact>","disposition":{"axis":"role|style|communication|budget_stated","value":"<short controlled value>","provenance":"stated|observed","confidence":0..1,"sourceQuote":"<short span>"}}]}
   Omit "disposition" entirely on any fact that doesn't clearly meet rule 4.`;

interface RawDisposition {
  axis?: unknown;
  value?: unknown;
  provenance?: unknown;
  confidence?: unknown;
  sourceQuote?: unknown;
}

interface RawCandidate {
  text?: unknown;
  disposition?: RawDisposition;
}

interface RawDistillResponse {
  facts?: RawCandidate[];
}

/** True iff `d` is a well-formed disposition candidate: a known axis, a non-empty value, a confidence
 * in [0,1], and — the fairness-structural check — a provenance that is EXACTLY "stated" or "observed".
 * Anything else (a hallucinated "inferred", a typo, a missing field) fails closed. Exported (PR-8) so
 * `service.ts` can re-apply the SAME reject-in-full check at the actual persistence boundary — defense
 * in depth for ANY `FactDistiller` a caller supplies, not just this module's own `createModelDistiller`. */
export function isValidDisposition(d: RawDisposition): boolean {
  if (typeof d.axis !== "string" || !DISPOSITION_AXES.includes(d.axis as DispositionAxis)) return false;
  if (typeof d.value !== "string" || !d.value.trim()) return false;
  if (d.provenance !== "stated" && d.provenance !== "observed") return false;
  if (typeof d.confidence !== "number" || Number.isNaN(d.confidence) || d.confidence < 0 || d.confidence > 1) return false;
  return true;
}

/** Pulls the first JSON object out of the model's response text, tolerating a markdown code fence
 * (mirrors judge/model-judge.ts's `extractJson`). Throws on anything that isn't extractable JSON — the
 * caller fails closed to `[]` rather than ever passing raw model prose through as a "fact". */
function extractDistillJson(text: string): RawDistillResponse {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence?.[1] ?? text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("distiller: no JSON object in model response");
  return JSON.parse(raw.slice(start, end + 1)) as RawDistillResponse;
}

/**
 * A governed, model-backed `FactDistiller` (ADR-0015 Inv 11). Calls `deps.model.complete` with the
 * forbidding prompt above and `responseSchema`, at `temperature: 0` for reproducibility. Returns ONLY
 * the `text` of candidates that either have no `disposition` at all, or a disposition that passes
 * `isValidDisposition` — anything else (bad JSON, a model error, an invalid disposition) is dropped,
 * failing closed to an empty/partial list rather than ever throwing or passing through unsafe content.
 * The returned strings still flow through the SAME `sanitizeFact` -> `classifyFact` ->
 * `decideMemoryWrite` -> `ttlForClass` pipeline in service.ts as `createStubDistiller`'s output — none
 * of those gates are reimplemented here.
 */
export function createModelDistiller(deps: ModelDistillerDeps): FactDistiller {
  return {
    async distill(turn) {
      let responseText: string;
      try {
        const res = await deps.model.complete({
          messages: [
            { role: "system", content: DISTILL_SYSTEM_PROMPT },
            { role: "user", content: `SHOPPER: ${turn.message}\nAGENT REPLY: ${turn.reply}` },
          ],
          temperature: 0,
          responseSchema: DISTILL_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
        });
        responseText = res.text;
      } catch {
        return []; // fail closed — a model/network error never becomes a stored fact
      }

      let parsed: RawDistillResponse;
      try {
        parsed = extractDistillJson(responseText);
      } catch {
        return []; // fail closed — unparseable model output never becomes a stored fact
      }

      const facts: DistilledCandidate[] = [];
      for (const candidate of parsed.facts ?? []) {
        if (typeof candidate?.text !== "string" || !candidate.text.trim()) continue;
        const rawDisposition = candidate.disposition;
        if (rawDisposition !== undefined && !isValidDisposition(rawDisposition)) continue; // reject the WHOLE candidate
        // PR-8 — surface the validated disposition instead of discarding it (previously only `text` was
        // returned). By this point `isValidDisposition` has already confirmed axis/value/provenance/
        // confidence are well-formed, so this is a safe, explicit narrowing (never a blind cast of
        // unchecked model JSON) into widget-memory's own typed `Disposition`.
        facts.push({
          text: candidate.text,
          disposition: rawDisposition
            ? {
                axis: rawDisposition.axis as DispositionAxis,
                value: rawDisposition.value as string,
                provenance: rawDisposition.provenance as "stated" | "observed",
                confidence: rawDisposition.confidence as number,
                sourceQuote: typeof rawDisposition.sourceQuote === "string" ? rawDisposition.sourceQuote : undefined,
              }
            : undefined,
        });
      }
      return facts;
    },
  };
}
