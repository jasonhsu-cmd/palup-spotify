// Model port — the ONLY way feature code touches an LLM (ADR-0001, CLAUDE.md §5).
// Feature code depends on this interface, never on a provider SDK. Adapters (mock,
// Vertex/Gemini, …) implement it and are swapped behind the port.

export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelRequest {
  messages: ModelMessage[];
  /** Deterministic knob; adapters must honor 0 => reproducible output where possible. */
  temperature?: number;
  maxTokens?: number;
  /** Opaque per-tenant tag for isolation/attribution — never used to leak across tenants. */
  tenantId?: string;
  /**
   * Optional JSON Schema constraining the response to valid JSON of that shape (structured outputs).
   * Adapters that support it (e.g. Anthropic `output_config.format`) enforce it at the provider;
   * adapters that don't simply ignore it. Used by the judge so a verdict can't come back as non-JSON.
   */
  responseSchema?: Record<string, unknown>;
}

export interface ModelResponse {
  text: string;
  /** Adapter/model identifier, for audit + eval provenance (e.g. "mock-1", "gemini-2.x"). */
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
}

// ── embed (OPTIONAL) ─────────────────────────────────────────────────────────────────────────────
// Embeddings ride on the `model` port by design, not convenience: ADR-0009 §3 ("embeddings are produced
// through the `model` port") and port-interfaces.md's `model` sketch (`embed(req: { texts, model? })`)
// both put them here, and it means one provider credential, one quota/fallback path, and ONE metering
// choke point (createMeteringModelPort) serve inference and embedding alike.
//
// WHY IT IS OPTIONAL: most adapters are completion-only (the deterministic mock, the judge's Anthropic
// adapters). Optional keeps every existing adapter and caller compiling and behaving IDENTICALLY, at the
// cost of one rule stated here and enforced by the contract suite:
//
//   AN ADAPTER THAT CANNOT EMBED MUST OMIT `embed` ENTIRELY — never provide a stub that throws.
//
// That rule is what keeps two different facts distinguishable: "this adapter cannot embed" is STATIC and
// free to check (`canEmbed(port)`, no spend, no network), while "the embedding call failed" is a REJECTED
// PROMISE from a declared capability. A throwing stub collapses them and a caller can no longer tell a
// permanent absence from a retryable failure.
//
// Deliberate omissions vs. port-interfaces.md's sketch (report, don't guess):
//  - No `model?` override on the request. Vector dimensionality, model name and provider task type are
//    the ADAPTER's business (ADR-0001); the response reports which model it used so the caller can pin it.
//
// ── `purpose`: what #188 deferred and #192 (B3) proved was needed ─────────────────────────────────
// #188 left `purpose` out ("adding an optional field later is backward-compatible") and flagged it for
// the Vertex PR. B3 then built that adapter and reported the consequence exactly: retrieval is
// ASYMMETRIC — a corpus and a query must be embedded differently — and Vertex's `task_type` DEFAULTS to
// the QUERY value when unset, so a corpus embedded without one silently gets query treatment. Both sides
// report the SAME `EmbedResponse.model`, so a `{model, dimension}` corpus pin cannot see the difference.
// B3's verdict: the port needs a portable `purpose` before any query-side embedding ships. It does now.
//
// IT IS REQUIRED, NOT OPTIONAL — a deliberate departure from #188's sketch. Optional would force the PORT
// to pick a default for an omitted purpose, and a defaulted purpose is precisely the provider defect
// reproduced one layer up: silent, invisible, and wrong for exactly one of the two callers. Required
// means the compiler asks the one question only the caller can answer, and no caller can forget it.
// The cost is a breaking change to every embed call site; there were two in the repo when this landed.
//
// AND IT IS ECHOED ON THE RESPONSE, reporting what the adapter ACTUALLY applied (requireEmbedAlignment
// enforces the echo). That is what finally makes the asymmetry catchable by a caller: a corpus manifest
// can pin `{model, dimension, purpose}` and refuse a query embedded on the wrong side. Encoding the task
// type into the port-visible `model` string would also have made it catchable — and would have dragged a
// Google concept across the port and split the price table in two, so it is not what we did.

/** Which SIDE of a retrieval this batch is. Portable by construction: no provider vocabulary, and a
 *  provider with no notion of asymmetry simply ignores it (its adapter maps both to the same call). */
export type EmbedPurpose = "document" | "query";

/** The closed vocabulary, for runtime validation of an untyped caller and for adapter mapping tables. */
export const EMBED_PURPOSES = ["document", "query"] as const satisfies readonly EmbedPurpose[];

function isEmbedPurpose(v: unknown): v is EmbedPurpose {
  return typeof v === "string" && (EMBED_PURPOSES as readonly string[]).includes(v);
}

export interface EmbedRequest {
  /** The BATCH to embed. Indexing a catalog is one call per batch, not one call per product; an adapter
   *  whose provider caps a request below `texts.length` MUST chunk internally and reassemble IN ORDER,
   *  or reject — it must never return fewer vectors than it was given (see requireEmbedAlignment). */
  texts: string[];
  /** REQUIRED — see the block above. `"document"` for a corpus you will later search; `"query"` for the
   *  search itself. Getting this wrong degrades retrieval SILENTLY, which is why there is no default. */
  purpose: EmbedPurpose;
  /** Opaque per-tenant tag for isolation/attribution — same meaning as ModelRequest.tenantId. */
  tenantId?: string;
}

export interface EmbedResponse {
  /** One vector per input text, in the SAME ORDER: `vectors[i]` embeds `texts[i]`. */
  vectors: number[][];
  /** The dimensionality every vector in `vectors` has. REQUIRED, not optional: a caller that mixes
   *  dimensions across one corpus gets silently meaningless similarity scores, so the port always states
   *  what it produced. The caller's obligation is to persist `{ model, dimension }` with the corpus and
   *  refuse to query/extend it when either changes. */
  dimension: number;
  /** Embedding-model identifier, for audit + eval provenance and cost attribution (keyed like
   *  ModelResponse.model in the price table / telemetry rollup). */
  model: string;
  /** The purpose the adapter ACTUALLY applied — not merely what was asked for. REQUIRED, for the same
   *  reason `dimension` is: the caller persists it with the corpus and refuses to query across a change.
   *  An adapter that cannot honour the requested purpose must REJECT, never quietly report a different
   *  one (requireEmbedAlignment turns a mismatched echo into a thrown error before anything is stored). */
  purpose: EmbedPurpose;
  /** Metered input tokens. Embedding has no completion tokens, so there is no outputTokens. Optional
   *  exactly like ModelResponse.usage: an adapter that cannot get a count OMITS this rather than
   *  reporting a 0 that would read as a free call in the cost meter (ADR-0013). */
  usage?: { inputTokens: number };
}

export interface ModelPort {
  complete(req: ModelRequest): Promise<ModelResponse>;
  /** OPTIONAL batch embedding — see the block comment above. Adapters that cannot embed OMIT this. */
  embed?(req: EmbedRequest): Promise<EmbedResponse>;
}

/** Does this adapter declare the embed capability? A STATIC, free check — and a type guard, so a caller
 *  narrows once instead of sprinkling `!`/casts (which is how a "cannot embed" turns into a TypeError at
 *  the call site and gets mistaken for a failure). */
export function canEmbed(port: ModelPort): port is ModelPort & { embed: NonNullable<ModelPort["embed"]> } {
  return typeof port.embed === "function";
}

/**
 * Validate an embed batch BEFORE any provider spend. Exported and called by EVERY adapter's `embed` (the
 * same discipline as VectorPort's requireCleanText) so a caller gets the identical fail-closed error from
 * every provider instead of one adapter erroring and another quietly returning a garbage vector.
 *
 * Fails on the WHOLE batch, naming the offending index. That is the point: a blank text yields a
 * meaningless (often zero) vector, and a zero vector stored for item 7 is a hole in the corpus that LOOKS
 * like data — the same silent-truncation failure class as a capped page size. The caller decides what to
 * do about the blank product (skip it, synthesize text, fix the catalog) as a visible decision.
 *
 * An EMPTY batch is rejected too: there is no honest `dimension` to report for zero texts, and no reason
 * to spend a call on nothing.
 *
 * It takes the whole REQUEST (not just `texts`) because `purpose` is validated here too: a caller that
 * reaches the port from untyped JavaScript, or with a value the compiler never saw, must be stopped
 * before spend rather than have the adapter guess a task type for it.
 */
export function requireEmbedInputs(req: EmbedRequest): void {
  if (!req || typeof req !== "object") throw new Error("ModelPort.embed: a request object is required");
  const texts = req.texts;
  if (!Array.isArray(texts)) throw new Error("ModelPort.embed: `texts` must be an array of strings");
  if (texts.length === 0)
    throw new Error("ModelPort.embed: `texts` must contain at least one text (an empty batch has no dimension to report)");
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    if (typeof t !== "string" || t.trim() === "")
      throw new Error(
        `ModelPort.embed: texts[index ${i}] is blank or not a string — the whole batch is rejected so a ` +
          "meaningless vector can never be stored in its place (decide what to do about it before embedding)",
      );
  }
  if (!isEmbedPurpose(req.purpose))
    throw new Error(
      `ModelPort.embed: \`purpose\` must be one of ${EMBED_PURPOSES.join(" | ")}, got ${JSON.stringify(req.purpose)} — ` +
        "there is no default because a defaulted purpose silently degrades retrieval (a corpus embedded as " +
        "a query still returns plausible-looking vectors)",
    );
}

/**
 * Validate an embed RESULT against the batch it answers: one vector per text, every vector of the
 * reported `dimension`, every component finite. Exported so adapters self-check before returning (and a
 * paranoid caller can re-check) with ONE implementation of the rule rather than three drifting ones; the
 * contract suite calls it too, so a truncating/reordering/dimension-mixing adapter fails to ship.
 *
 * `vectors.length !== texts.length` is the anti-truncation invariant: a short answer is exactly the
 * silently-capped result this codebase has already been bitten by, and it is unrecoverable here — the
 * caller cannot tell WHICH text lost its vector, so the whole response is rejected.
 *
 * It takes the whole REQUEST so it can also check the PURPOSE ECHO: an adapter that was asked to embed a
 * corpus and answered with a query embedding has produced perfectly well-formed, plausible-looking, wrong
 * vectors. That is the one failure in this family with no downstream symptom at all — same model, same
 * dimension, same shape — so it is checked here, in the one validator every adapter already calls, rather
 * than left to each caller to remember.
 */
export function requireEmbedAlignment(req: EmbedRequest, res: EmbedResponse): void {
  const texts = req.texts;
  if (!isEmbedPurpose(res.purpose) || res.purpose !== req.purpose)
    throw new Error(
      `ModelPort.embed: asked for purpose ${JSON.stringify(req.purpose)} but the adapter reports ` +
        `${JSON.stringify(res.purpose)} — rejecting the batch rather than storing vectors built for the ` +
        "other side of retrieval (they are the right shape and the wrong space, so nothing downstream would notice)",
    );
  if (res.vectors.length !== texts.length)
    throw new Error(
      `ModelPort.embed: ${texts.length} texts in but ${res.vectors.length} vectors out — a partial batch is ` +
        "rejected whole (which text lost its vector is not recoverable, and a hole in a corpus looks like data)",
    );
  if (!Number.isInteger(res.dimension) || res.dimension <= 0)
    throw new Error(`ModelPort.embed: dimension must be a positive integer, got ${String(res.dimension)}`);
  for (let i = 0; i < res.vectors.length; i++) {
    const v = res.vectors[i];
    if (!Array.isArray(v) || v.length !== res.dimension)
      throw new Error(
        `ModelPort.embed: vectors[${i}] has ${Array.isArray(v) ? v.length : "no"} components but the response ` +
          `reports dimension ${res.dimension} — mixed dimensions in one corpus rank as garbage`,
      );
    for (let j = 0; j < v.length; j++) {
      if (!Number.isFinite(v[j]))
        throw new Error(`ModelPort.embed: vectors[${i}][${j}] is not finite — a NaN/Infinity vector scores against nothing`);
    }
  }
}
