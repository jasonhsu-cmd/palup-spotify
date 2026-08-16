import {
  requireEmbedAlignment,
  requireEmbedInputs,
  type EmbedPurpose,
  type EmbedRequest,
  type EmbedResponse,
  type ModelPort,
  type ModelRequest,
  type ModelResponse,
} from "@palup/platform-ports";

// The single Gemini call, injected. This isolates the SDK so ALL of the adapter's own logic
// (message->contents mapping, response parsing, error handling, token accounting) is unit-tested
// WITHOUT cloud creds. createVertexAdapter() (create.ts) wires the real @google/genai call in.
export interface GenContent {
  role: "user" | "model";
  parts: { text: string }[];
}
export interface GenRequest {
  model: string;
  contents: GenContent[];
  config?: {
    systemInstruction?: string;
    temperature?: number;
    maxOutputTokens?: number;
    // Gemini "thinking" control (@google/genai ThinkingConfig). `thinkingLevel` is the enum lever
    // (MINIMAL | LOW | MEDIUM | HIGH); lower = faster + cheaper, at some reasoning cost. Omitted ⇒ the
    // model's own default (MEDIUM for gemini-3.5-flash). The exact shape is read from the installed SDK's
    // ThinkingConfig type, not from memory.
    thinkingConfig?: { thinkingLevel?: string; thinkingBudget?: number };
  };
}
export interface GenResponse {
  text?: string;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  // Surfaced so an EMPTY completion is diagnosable instead of an opaque "empty completion" throw. A
  // Gemini response can be empty for very different reasons — a safety/recitation block (blockReason /
  // finishReason SAFETY|RECITATION), truncation (MAX_TOKENS, incl. thinking tokens), or genuinely no
  // candidate — and the fix differs by cause. This underlies EVERY conversation test, so it must not be
  // silently opaque.
  finishReason?: string;
  blockReason?: string;
}
export type GenerateFn = (req: GenRequest) => Promise<GenResponse>;

export interface VertexConfig {
  model: string;
  /** Optional Gemini thinking level (MINIMAL | LOW | MEDIUM | HIGH). Latency/quality lever; unset ⇒ the
   * model default. Set from PALUP_THINKING_LEVEL in create.ts. */
  thinkingLevel?: string;
}

// ── embeddings (B3) ───────────────────────────────────────────────────────────────────────────────
//
// PRIMARY SOURCES. Every wire-format and limit fact below is quoted from one of these; nothing here is
// written from memory. Docs retrieved 2026-08-06; the SDK facts are read out of the version this package
// actually depends on.
//
// [E1] "Get text embeddings" — https://cloud.google.com/vertex-ai/generative-ai/docs/embeddings/get-text-embeddings
//      (301 -> https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/embeddings/get-text-embeddings),
//      page states "Last updated 2026-07-30 UTC".
//   • Node.js sample: `new GoogleGenAI({ vertexai: true, project })` then
//     `client.models.embedContent({ model:'gemini-embedding-001', contents:[…3 strings…],
//      config:{ taskType:'RETRIEVAL_DOCUMENT', outputDimensionality:3072, title:… } })`, with
//     `GOOGLE_CLOUD_LOCATION=global` — the same client + env this file's `complete` path already uses.
//   • "All models produce a full-length embedding vector by default. For gemini-embedding-001, this
//     vector has 3072 dimensions, and other models produce 768-dimensional vectors."
//   • "The vectors are normalized, so you can use cosine similarity, dot product, or Euclidean distance
//     to provide the same similarity rankings." (VectorPort ranks with cosine — vector-port.ts:144.)
//   • API limits, verbatim: "For each request, you're limited to 250 input texts. The API has a maximum
//     input token limit of 20,000… Each individual input text is further limited to 2048 tokens; any
//     excess is silently truncated. You can also disable silent truncation by setting autoTruncate to
//     false."
//   • REST: `POST https://{REGION}-aiplatform.googleapis.com/v1/projects/{PROJECT}/locations/{REGION}/
//     publishers/google/models/{MODEL_ID}:predict`, body `{ instances:[{content}], parameters:{autoTruncate} }`,
//     response `{ predictions:[{ embeddings:{ statistics:{truncated, token_count}, values:[…] } }] }`.
//
// [E2] "Text embeddings API" reference — https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/text-embeddings-api,
//      page states "Last updated 2026-08-04 UTC".
//   • `task_type` — "Optional: string Used to convey intended downstream application to help the model
//     produce better embeddings. If left blank, the DEFAULT USED IS RETRIEVAL_QUERY." Enum includes
//     RETRIEVAL_QUERY, RETRIEVAL_DOCUMENT, SEMANTIC_SIMILARITY, CLASSIFICATION, CLUSTERING,
//     QUESTION_ANSWERING, FACT_VERIFICATION, CODE_RETRIEVAL_QUERY.
//   • `autoTruncate` — "Defaults to true."   `outputDimensionality` — "If set, output embeddings will be
//     truncated to the size specified."
//   • THE BATCH LIMIT, verbatim: "Limit: five texts of up to 2,048 tokens per text for all models except
//     textembedding-gecko@001… FOR GEMINI-EMBEDDING-001, EACH REQUEST CAN ONLY INCLUDE A SINGLE INPUT
//     TEXT." Its own Node.js sample loops one instance per request with the comment
//     "// gemini-embedding-001 takes one input at a time."
//
// [E3] "Choose an embeddings task type" — https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/embeddings/task-types,
//      "Last updated 2026-07-30 UTC": "To get the best performance, you must use different task types to
//      generate embeddings for your corpus and your queries… When embedding these documents, use the
//      RETRIEVAL_DOCUMENT task type… when a user submits a search… RETRIEVAL_QUERY."
//
// [E4] Model retirement — https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions,
//      "Last updated 2026-08-03 UTC": gemini-embedding-001 released 2025-05-20, retirement
//      "No sooner than May 20, 2028". (text-embedding-005 retires 2027-04-01.)
//
// [E5] The SDK this package depends on — @google/genai 1.52.0 (`"@google/genai": "^1.0.0"` in
//      package.json; version read from the installed tree). Read directly, not recalled:
//   • `dist/genai.d.ts:8116` — `embedContent: (params: EmbedContentParameters) => Promise<EmbedContentResponse>`
//   • `dist/genai.d.ts:3439-3446` — `EmbedContentResponse.embeddings?: ContentEmbedding[]`, documented as
//     "The embeddings for each request, IN THE SAME ORDER AS PROVIDED IN THE BATCH REQUEST."
//   • `dist/genai.d.ts:2192-2211` — `ContentEmbedding { values?: number[]; statistics?: { truncated?:
//     boolean; tokenCount?: number } }`.
//   • `dist/genai.d.ts:3357-3397` — `EmbedContentConfig { taskType?; title?; outputDimensionality?;
//     autoTruncate?; … }`.
//   • `dist/node/index.mjs:14528-14550` — the VERTEX dispatch, which is why the cap table below is what
//     it is: a `gemini*` model that is NOT `gemini-embedding-001` (e.g. gemini-embedding-2) goes down the
//     EMBED_CONTENT path and the SDK ITSELF THROWS "The embedContent API for this model only supports one
//     content at a time." for more than one content; everything else goes down the PREDICT path, where
//     `dist/node/index.mjs:9756-9766` maps `contents` -> `instances[].content` and `:9603` stamps
//     `taskType` onto EVERY instance. Responses come back from `predictions[].embeddings`
//     (`:9810-9829`) with `token_count` renamed to `tokenCount` (`:9213`).
//
// AN UNRESOLVED CONTRADICTION IN GOOGLE'S OWN DOCS, recorded rather than resolved by guess: [E1]'s "API
// limits" says 250 input texts per request while [E2] says gemini-embedding-001 takes exactly one. They
// cannot both be true for the same call. [E2] is the endpoint reference, it is the more recently updated
// page, and the SDK's shipped code agrees with it, so THE ADAPTER IMPLEMENTS THE LOWER BOUND. Being wrong
// low costs round-trips; being wrong high costs a 400 that fails a merchant's whole index.
//
// PORTABILITY (ADR-0001, CLAUDE.md §3.3): none of this crosses `ModelPort`. The embedding model id, the
// task type, the per-request cap and the output dimensionality are ADAPTER-INTERNAL config; the port
// hands over `texts` and gets back `{ vectors, dimension, model, usage? }`.

/** Wire shape of one `models.embedContent` request — a hand-written mirror of [E5]'s surface, so the
 *  Google SDK type never leaks into this package's exports (same discipline as `GenRequest`). */
export interface VertexEmbedRequest {
  model: string;
  contents: string[];
  config?: {
    taskType?: string;
    outputDimensionality?: number;
    autoTruncate?: boolean;
  };
}

/** Wire shape of one `models.embedContent` response ([E5]). Every field optional: the adapter validates
 *  at runtime rather than trusting the provider's shape. */
export interface VertexEmbedResponse {
  embeddings?: {
    values?: number[];
    statistics?: { truncated?: boolean; tokenCount?: number };
  }[];
  metadata?: { billableCharacterCount?: number };
}

/** The single embedding call, injected — exactly like `GenerateFn`, and for the same reason: all of the
 *  chunking / alignment / usage / fail-closed logic below is unit-tested with NO cloud creds. */
export type EmbedContentFn = (req: VertexEmbedRequest) => Promise<VertexEmbedResponse>;

export interface VertexEmbedConfig {
  /** Embedding model id. Reported on `EmbedResponse.model`, so it is also the price-table key. */
  model: string;
  /**
   * Provider task type PER PORTABLE PURPOSE ([E2]/[E3]) — the mapping that keeps `RETRIEVAL_DOCUMENT` /
   * `RETRIEVAL_QUERY` on this side of the port while `EmbedRequest.purpose` says only "document"/"query".
   * A MAP rather than a single value because retrieval is asymmetric ([E3]): one value cannot express a
   * pair, and B3's stopgap — "a query path must construct a SECOND adapter" — was the shape of that
   * limitation, not a design.
   */
  taskTypes: Readonly<Record<EmbedPurpose, string>>;
  /** Texts per PROVIDER request. The port's batch is chunked to this and reassembled in order. */
  maxBatch: number;
  /** Optional `outputDimensionality` ([E2]). Left unset => the model's full-length vector ([E1]). */
  outputDimensionality?: number;
  /**
   * Provider-side silent truncation of an over-long input ([E1]: "any excess is silently truncated").
   * Defaults to FALSE here: a vector built from a truncated description is a quality loss that looks
   * exactly like a good vector, and this repo's standing rule is to refuse rather than silently degrade.
   */
  autoTruncate?: boolean;
  /** Per-provider-request timeout (ms). Undefined ⇒ no timeout (the pre-S2 behaviour). */
  timeoutMs?: number;
  /** Max retries per chunk on a transient failure/timeout. Undefined/0 ⇒ no retry. */
  maxRetries?: number;
  /** Max provider requests in flight at once. Undefined ⇒ 1 (sequential, the pre-S2 behaviour). */
  concurrency?: number;
}

/** The embedding side of the adapter: a transport plus the config it is called with. */
export interface VertexEmbedding {
  call: EmbedContentFn;
  cfg: VertexEmbedConfig;
}

/**
 * Default embedding model. `gemini-embedding-001` for three reasons that are checkable, not preferences:
 *  1. It is priced PER INPUT TOKEN (Vertex pricing, "Gemini Embedding": $0.00015 per 1,000 input tokens,
 *     online; output "No charge" — retrieved 2026-08-06 from
 *     https://cloud.google.com/vertex-ai/generative-ai/pricing). `deriveCostUsd` multiplies TOKENS by a
 *     per-1M-token price (telemetry-cost.ts:69), and the gecko-family models are priced per 1,000
 *     CHARACTERS on that same page — so choosing one of those would make the cost meter structurally
 *     wrong, not merely unpriced.
 *  2. It has the longest documented runway: retirement "No sooner than May 20, 2028" ([E4]).
 *  3. Google's own docs recommend it: "For superior embedding quality, gemini-embedding-001 is our large
 *     model designed to provide the highest performance" ([E1]). That is a VENDOR CLAIM, not a
 *     measurement — nothing in this repo has benchmarked it.
 * Override with `PALUP_EMBED_MODEL` (create.ts), the same escape hatch `PALUP_MODEL` gives `complete`.
 */
export const DEFAULT_EMBED_MODEL = "gemini-embedding-001";

/**
 * The purpose -> task type mapping, and THE FIX FOR THE PORT GAP B3 REPORTED.
 *
 * B3 shipped a single `taskType` defaulting to `RETRIEVAL_DOCUMENT` and said plainly what it could not
 * fix: [E3] is explicit that retrieval is ASYMMETRIC ("you must use different task types to generate
 * embeddings for your corpus and your queries"), [E2] says an unset `task_type` DEFAULTS TO
 * RETRIEVAL_QUERY, and both sides report the same `EmbedResponse.model` — so a caller's
 * `{model, dimension}` pin could not catch a corpus embedded on the wrong side. Its verdict was that the
 * PORT needed a portable `purpose` before any query-side embedding shipped. E1 is query-side embedding,
 * so `EmbedRequest.purpose` now exists (model-port.ts) and this table is its provider mapping.
 *
 * Two properties this table exists to guarantee:
 *  1. A TASK TYPE IS ALWAYS SENT. "Unset" is never a state this adapter can be in, so [E2]'s
 *     default-to-RETRIEVAL_QUERY can never silently apply to a corpus.
 *  2. ONE ADAPTER SERVES BOTH SIDES. B3's stopgap ("construct a SECOND adapter with
 *     PALUP_EMBED_TASK_TYPE=RETRIEVAL_QUERY and do not reuse this instance") is retired — a second
 *     instance would also have meant two price-table keys for one model and two credential paths.
 *
 * The values are Google's, from [E3]; the KEYS are the port's portable vocabulary. Nothing here crosses
 * the port: `EmbedResponse` reports `purpose`, never a task type (ADR-0001, CLAUDE.md §3.3).
 */
export const DEFAULT_EMBED_TASK_TYPES: Readonly<Record<EmbedPurpose, string>> = Object.freeze({
  document: "RETRIEVAL_DOCUMENT",
  query: "RETRIEVAL_QUERY",
});

/**
 * Texts the PROVIDER accepts in one request, per model — the documented cap, with a deliberately
 * conservative fallback.
 *
 *   gemini-embedding-001                  1   [E2] "each request can only include a single input text",
 *                                             and its own Node sample: "takes one input at a time".
 *   text-embedding-005                    5   [E2] "Limit: five texts of up to 2,048 tokens per text".
 *   text-embedding-004                    5   same sentence.
 *   text-multilingual-embedding-002       5   same sentence.
 *   anything else                         1   NOT a guess upward. An unknown id may be a `gemini*` model,
 *                                             which the SDK routes to the EMBED_CONTENT path where it
 *                                             throws for >1 content ([E5]) — so 1 is the only value that
 *                                             is safe without a fresh doc check. Override deliberately
 *                                             with PALUP_EMBED_MAX_BATCH.
 *
 * These are drifting vendor facts. Re-check [E2] before raising any of them.
 */
const EMBED_MAX_BATCH: Readonly<Record<string, number>> = Object.freeze({
  "gemini-embedding-001": 1,
  "text-embedding-005": 5,
  "text-embedding-004": 5,
  "text-multilingual-embedding-002": 5,
});

export function maxBatchForEmbedModel(model: string): number {
  return Object.hasOwn(EMBED_MAX_BATCH, model) ? EMBED_MAX_BATCH[model]! : 1;
}

export class VertexModelAdapter implements ModelPort {
  /**
   * OPTIONAL batch embedding. Assigned in the constructor ONLY when an embedding transport was supplied,
   * which is #188's absence rule made structural (model-port.ts:42): an adapter that cannot embed OMITS
   * the method rather than providing a stub that throws, so `canEmbed` keeps "this deployment has no
   * embedder" (static, free) distinguishable from "the embedding call failed" (runtime, retryable).
   * `createVertexAdapter` always supplies one, so a DEPLOYED adapter always reports `canEmbed === true`.
   */
  readonly embed?: NonNullable<ModelPort["embed"]>;

  constructor(
    private readonly generate: GenerateFn,
    private readonly cfg: VertexConfig,
    embedding?: VertexEmbedding,
  ) {
    if (embedding) this.embed = (req: EmbedRequest) => this.embedBatch(embedding, req);
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    // Gemini takes systemInstruction separately; user/assistant turns become contents (assistant->model).
    const systemInstruction =
      req.messages
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .join("\n\n") || undefined;

    const contents: GenContent[] = req.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    const res = await this.generate({
      model: this.cfg.model,
      contents,
      config: {
        systemInstruction,
        temperature: req.temperature ?? 0,
        maxOutputTokens: req.maxTokens,
        // Only sent when configured (PALUP_THINKING_LEVEL); otherwise the model applies its own default.
        ...(this.cfg.thinkingLevel ? { thinkingConfig: { thinkingLevel: this.cfg.thinkingLevel } } : {}),
      },
    });

    const text = (res.text ?? "").trim();
    if (!text)
      throw new Error(
        `vertex: model returned empty completion (finishReason=${res.finishReason ?? "?"}, blockReason=${res.blockReason ?? "none"})`,
      );

    return {
      text,
      model: this.cfg.model,
      usage: res.usageMetadata
        ? {
            inputTokens: res.usageMetadata.promptTokenCount ?? 0,
            outputTokens: res.usageMetadata.candidatesTokenCount ?? 0,
          }
        : undefined,
    };
  }

  /**
   * Embed a batch, ALL-OR-NOTHING at the port boundary.
   *
   * The provider caps texts per request well below the caller's batch size (`DEFAULT_EMBED_BATCH` is 250,
   * catalog-index.ts:126; the cap is 1 for the default model — [E2]), so this chunks internally. What
   * keeps that honest is that NOTHING is returned until EVERY chunk has come back and validated: a chunk
   * that throws, comes back short, comes back long, drifts dimension, or reports a truncated input
   * rejects the WHOLE call. A short answer is unrecoverable for the caller — it cannot tell which text
   * lost its vector, and a hole in a corpus looks like data (model-port.ts:133) — so there is no
   * "partial success" return path here at all.
   *
   * NOT ATOMIC AT THE PROVIDER, stated plainly: a chunk that already succeeded was already billed. This
   * method's guarantee is about what the CALLER receives (all vectors or an exception), not about
   * refunding spend. `createMeteringModelPort` does not meter a rejected embed (metering.ts:54), so a
   * failed run's already-billed chunks are not in the cost meter either — real spend, invisible to it.
   *
   * TIMEOUT + RETRY/BACKOFF + BOUNDED CONCURRENCY (S2): a 50k-product index (`MAX_INDEXED_PRODUCTS`,
   * catalog-index.ts:115) run one-chunk-at-a-time, with no timeout and no retry, is the throughput and
   * resilience gap the pre-S2 version of this method reported rather than fixed. `cfg.timeoutMs` bounds
   * one provider request; `cfg.maxRetries` retries a chunk that throws or times out with exponential
   * backoff (capped at 2s); `cfg.concurrency` runs that many chunks in flight via a simple pull-based
   * worker pool. None of the three change the ALL-OR-NOTHING contract above: the first chunk that
   * exhausts its retries rejects the whole batch, in-flight siblings included. Every field defaults to the
   * pre-S2 behaviour (no timeout, no retry, concurrency 1 ⇒ strictly sequential), so `vertex-embed.test.ts`
   * / `vertex-embed-purpose.test.ts` / `vertex-adapter.test.ts` — none of which set these fields — are
   * unaffected.
   *
   * The port's `tenantId` is NOT forwarded to Google. Attribution happens locally in the metering
   * decorator (metering.ts:55); sending a tenant id to the provider would be egress with no purpose.
   */
  private async embedBatch(embedding: VertexEmbedding, req: EmbedRequest): Promise<EmbedResponse> {
    const { call, cfg } = embedding;
    // BEFORE any provider spend, and with the PORT's validator rather than a restatement of the rule, so
    // every adapter fails identically on a blank/empty batch AND on a purpose outside the vocabulary.
    requireEmbedInputs(req);

    // Resolve the provider task type from the portable purpose. `Object.hasOwn` before indexing, so a
    // purpose that somehow slipped the validator can never resolve through the prototype chain to an
    // inherited member and be stamped onto a request as a task type.
    if (!Object.hasOwn(cfg.taskTypes, req.purpose))
      throw new Error(`vertex: no task type configured for embed purpose ${JSON.stringify(req.purpose)}`);
    const taskType = cfg.taskTypes[req.purpose];
    if (!taskType)
      throw new Error(`vertex: the task type configured for embed purpose ${JSON.stringify(req.purpose)} is blank`);

    const chunkSize = Math.max(1, Math.floor(cfg.maxBatch));
    const concurrency = Math.max(1, Math.floor(cfg.concurrency ?? 1));
    const maxRetries = Math.max(0, Math.floor(cfg.maxRetries ?? 0));

    // Split into ordered, offset-tagged chunks; each is validated independently and placed back by index
    // so concurrent completion order never affects the final `vectors` order.
    const chunks: { offset: number; texts: string[] }[] = [];
    for (let o = 0; o < req.texts.length; o += chunkSize) chunks.push({ offset: o, texts: req.texts.slice(o, o + chunkSize) });

    const perChunk: { values: number[][]; tokens: number | undefined }[] = new Array(chunks.length);

    const withTimeout = async <T>(p: Promise<T>): Promise<T> => {
      if (cfg.timeoutMs === undefined) return p;
      return await Promise.race([
        p,
        new Promise<T>((_r, rej) => setTimeout(() => rej(new Error("vertex: embed request timed out")), cfg.timeoutMs)),
      ]);
    };

    const runChunk = async (ci: number): Promise<void> => {
      const { offset, texts } = chunks[ci]!;
      let lastErr: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const res = await withTimeout(
            call({
              model: cfg.model,
              contents: texts,
              config: {
                taskType,
                autoTruncate: cfg.autoTruncate ?? false,
                ...(cfg.outputDimensionality === undefined ? {} : { outputDimensionality: cfg.outputDimensionality }),
              },
            }),
          );
          perChunk[ci] = this.validateChunk(offset, texts, res, cfg.outputDimensionality); // throws on any anomaly
          return;
        } catch (e) {
          lastErr = e;
          if (attempt < maxRetries) await new Promise((r) => setTimeout(r, Math.min(2000, 100 * 2 ** attempt))); // backoff
        }
      }
      throw lastErr;
    };

    // Bounded pool: at most `concurrency` chunks in flight. The first rejection propagates out of
    // Promise.all and fails the whole batch — in-flight siblings are not awaited further by the caller,
    // matching the pre-existing all-or-nothing contract.
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < chunks.length) {
        const ci = next++;
        await runChunk(ci);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, () => worker()));

    // Reassemble in order + enforce a single dimension across chunks (a provider could in principle answer
    // two chunks of the same request with two different dimensions; that is exactly as invalid here as it
    // was in the old within-chunk check, just now across chunks instead of within one).
    const vectors: number[][] = [];
    let dimension = 0;
    let inputTokens = 0;
    let tokensKnown = true;
    for (const c of perChunk) {
      for (const v of c.values) {
        if (dimension === 0) dimension = v.length;
        else if (v.length !== dimension)
          throw new Error(`vertex: mixed dimensions across chunks (${v.length} vs ${dimension})`);
        vectors.push(v);
      }
      if (c.tokens === undefined) tokensKnown = false;
      else inputTokens += c.tokens;
    }

    const out: EmbedResponse = {
      vectors,
      dimension,
      model: cfg.model,
      // What was ACTUALLY applied: `taskType` above is `cfg.taskTypes[req.purpose]`, so reporting the
      // request's purpose here is a statement about this call, not an echo of an unread field.
      purpose: req.purpose,
      ...(tokensKnown ? { usage: { inputTokens } } : {}),
    };
    // The port's own result validator, not a second copy of the rule: one vector per text, all of the
    // reported dimension, every component finite, and the purpose echoed. Adapter and contract cannot drift.
    requireEmbedAlignment(req, out);
    return out;
  }

  /**
   * Validate ONE chunk's response against what was sent, returning its vectors + (if known) its token
   * count. Extracted from the pre-S2 sequential loop verbatim (same error messages, same checks) so that
   * bounded-concurrency callers and any future caller share one validator instead of two copies drifting.
   * Throws on any anomaly — a throw here is what makes a chunk "fail" for `runChunk`'s retry loop above.
   */
  private validateChunk(
    offset: number,
    chunk: string[],
    res: VertexEmbedResponse,
    outputDimensionality: number | undefined,
  ): { values: number[][]; tokens: number | undefined } {
    const got = res.embeddings ?? [];
    if (got.length !== chunk.length) {
      throw new Error(
        `vertex: embed chunk at offset ${offset} sent ${chunk.length} text(s) and got ${got.length} ` +
          "vector(s) back — rejecting the whole batch (which text lost its vector is not recoverable, " +
          "and a hole in a corpus looks like data)",
      );
    }

    const values: number[][] = [];
    let dimension = 0;
    let inputTokens = 0;
    let tokensKnown = true;

    for (let j = 0; j < got.length; j++) {
      const index = offset + j;
      const e = got[j]!;

      // Silent input truncation ([E1]) produces a perfectly well-formed vector built from PART of the
      // text. `autoTruncate:false` should already have turned that into a provider error; this is the
      // belt to that braces, for a provider that ignores the flag. Never the text itself in the message.
      if (e.statistics?.truncated === true) {
        throw new Error(
          `vertex: the provider reports the text at index ${index} was TRUNCATED before embedding — ` +
            "rejecting the batch rather than storing a vector built from part of the text",
        );
      }

      const v = e.values;
      if (!Array.isArray(v) || v.length === 0) {
        throw new Error(
          `vertex: no embedding values returned for the text at index ${index} — rejecting the whole ` +
            "batch rather than returning an empty vector",
        );
      }

      if (dimension === 0) {
        dimension = v.length;
        // A provider that silently ignored `outputDimensionality` must not have its vectors pinned
        // under the dimension we ASKED for: the caller persists this number with the corpus.
        if (outputDimensionality !== undefined && dimension !== outputDimensionality) {
          throw new Error(
            `vertex: asked for ${outputDimensionality} dimensions but the provider returned ` +
              `${dimension} — refusing to pin a corpus to a dimension that was not honored`,
          );
        }
      } else if (v.length !== dimension) {
        throw new Error(
          `vertex: the text at index ${index} came back with ${v.length} components but this ` +
            `batch's dimension is ${dimension} — mixed dimensions in one corpus rank as garbage`,
        );
      }

      // Usage is all-or-nothing too. A sum over only the texts that reported a count is a number that
      // READS like a full cost and is not one, so an incomplete count omits `usage` entirely — the same
      // rule `complete` follows and the port states (model-port.ts:77).
      const tc = e.statistics?.tokenCount;
      if (typeof tc === "number" && Number.isFinite(tc) && tc >= 0) inputTokens += tc;
      else tokensKnown = false;

      values.push(v);
    }

    return { values, tokens: tokensKnown ? inputTokens : undefined };
  }
}
