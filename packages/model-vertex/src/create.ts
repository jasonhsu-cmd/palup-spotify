// ⚠️ UNVERIFIED-LIVE: this is the only code that touches the real Vertex/Gemini SDK. It matches
// the @google/genai documented surface as of 2026-07 (Google Cloud docs + googleapis/js-genai), and the
// embedding path below was written against the SAME SDK's shipped types + the Vertex embeddings docs
// (citations [E1]–[E5] in vertex-adapter.ts, retrieved 2026-08-06), but NEITHER path has been executed
// against a live Vertex endpoint in this environment (no GCP creds). The adapter LOGIC both wire in is
// fully unit-tested (vertex-adapter.test.ts, vertex-embed.test.ts). Confirm the exact `usageMetadata` /
// `embeddings[].statistics` field names, the current model ids, and the REAL vector dimension against
// live Vertex before relying on them — `pnpm model:smoke` is the command that does it.
import type { EmbedPurpose } from "@palup/platform-ports";
import {
  DEFAULT_EMBED_MODEL,
  DEFAULT_EMBED_TASK_TYPES,
  maxBatchForEmbedModel,
  VertexModelAdapter,
  type EmbedContentFn,
  type GenerateFn,
  type GenRequest,
  type VertexEmbedRequest,
} from "./vertex-adapter.js";

export interface CreateVertexOptions {
  project?: string;
  location?: string;
  model?: string;
  /** Gemini thinking level (MINIMAL | LOW | MEDIUM | HIGH); defaults to PALUP_THINKING_LEVEL, else unset
   * (the model's own default). Latency/quality lever — lower is faster + cheaper. */
  thinkingLevel?: string;
  /** Embedding model id; defaults to PALUP_EMBED_MODEL, then DEFAULT_EMBED_MODEL. */
  embedModel?: string;
  /**
   * Provider task type PER PORTABLE PURPOSE; each side defaults to
   * `PALUP_EMBED_TASK_TYPE_DOCUMENT` / `PALUP_EMBED_TASK_TYPE_QUERY`, then `DEFAULT_EMBED_TASK_TYPES`.
   */
  embedTaskTypes?: Partial<Record<EmbedPurpose, string>>;
  /** Texts per provider request; defaults to PALUP_EMBED_MAX_BATCH, then the per-model documented cap. */
  embedMaxBatch?: number;
  /** `outputDimensionality`; defaults to PALUP_EMBED_DIMENSION, else unset (the model's full length). */
  embedDimension?: number;
  /** Injected embedding transport — TESTS ONLY. Production leaves it unset and gets the real SDK call. */
  embedContent?: EmbedContentFn;
  /**
   * WS-E1 — hard ceiling on ONE `complete()` call (a single reactive /chat turn). Defaults to
   * PALUP_MODEL_TIMEOUT_MS, else 30000ms — chat needs more headroom than the embed path's default
   * (20000ms, index-only) so a normal slow response is not false-timed-out, while still bounding a
   * genuinely hung call instead of letting it hang the whole request.
   */
  completeTimeoutMs?: number;
}

export function isVertexConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLOUD_PROJECT);
}

/** Read a positive integer from the environment, ignoring anything that is not one (no silent 0/NaN). */
function positiveIntEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function createVertexAdapter(opts: CreateVertexOptions = {}): VertexModelAdapter {
  const project = opts.project ?? process.env.GOOGLE_CLOUD_PROJECT;
  // "global" is the default Vertex endpoint; staging pins GOOGLE_CLOUD_LOCATION=global and
  // PALUP_MODEL=gemini-3.5-flash (.github/workflows/deploy-staging.yml). The live end-to-end call
  // against that endpoint is NOT independently verified in this repo (see the UNVERIFIED-LIVE header
  // above); some models/regions differ — override via GOOGLE_CLOUD_LOCATION. The embeddings docs' own
  // Node.js sample also pairs GOOGLE_CLOUD_LOCATION=global with gemini-embedding-001 ([E1]).
  const location = opts.location ?? process.env.GOOGLE_CLOUD_LOCATION ?? "global";
  // Model ids change; keep it env-overridable. Confirm availability for your project/region in
  // Model Garden. Moved off gemini-2.5-flash (GA 2026-07, RETIRES 2026-10-16) to gemini-3.5-flash
  // (GA per Google's 2026 Gemini-3 release). NOTE: this default has NOT been validated against the
  // live model in this repo — run drift-check.yml (live smoke + cross-family judge) and confirm the id
  // resolves in the project's Vertex region before serving shoppers (see the UNVERIFIED-LIVE header above).
  const model = opts.model ?? process.env.PALUP_MODEL ?? "gemini-3.5-flash";
  // Gemini "thinking" level — a latency/quality lever (gemini-3.5-flash dev guide). DEFAULT: MINIMAL.
  // Validated by a live eval:full A/B on 2026-08-07 (gemini-3.5-flash, 190 cases, Claude judge): MINIMAL
  // scored 75% at p50 1.66s/call vs the model-default MEDIUM's 73% at p50 15.2s — ~9× faster with NO quality
  // cost (LOW was worse on both axes). For a shopper chat agent the extra reasoning bought latency, not
  // quality. Overridable per-deployment via PALUP_THINKING_LEVEL (MINIMAL|LOW|MEDIUM|HIGH); an unrecognised
  // value falls back to MINIMAL. Env-driven so feature code stays model-agnostic.
  const thinkingLevel = (() => {
    const raw = (opts.thinkingLevel ?? process.env.PALUP_THINKING_LEVEL ?? "MINIMAL").trim().toUpperCase();
    return new Set(["MINIMAL", "LOW", "MEDIUM", "HIGH"]).has(raw) ? raw : "MINIMAL";
  })();
  if (!project) {
    throw new Error(
      "createVertexAdapter: set GOOGLE_CLOUD_PROJECT (and GOOGLE_CLOUD_LOCATION) or pass opts.project",
    );
  }
  // WS-E1: config-driven, defaulted — a deployment that has never set PALUP_MODEL_TIMEOUT_MS still gets a
  // bound (30s) rather than silently staying unbounded, unlike the embed knobs above (which default to
  // pre-existing unbounded/no-retry behaviour because THEY are new resilience knobs on an existing method
  // signature). complete()'s previous total absence of a bound is exactly the gap this closes.
  const completeTimeoutMs = opts.completeTimeoutMs ?? positiveIntEnv(process.env.PALUP_MODEL_TIMEOUT_MS) ?? 30000;

  // Lazy dynamic import: importing this package (e.g. in the backend's mock mode) never loads the
  // Google SDK. It resolves+initializes only on the FIRST real Vertex call — and ONE client serves both
  // `generateContent` and `embedContent`, so completion and embedding share a single Application Default
  // Credentials path. No key material is read, held or logged here (CLAUDE.md §5 secrets rule).
  let clientPromise: Promise<any> | null = null;
  const client = (): Promise<any> => {
    if (!clientPromise) {
      clientPromise = import("@google/genai").then(
        ({ GoogleGenAI }) => new GoogleGenAI({ vertexai: true, project, location }),
      );
    }
    return clientPromise;
  };

  const generate: GenerateFn = async (req: GenRequest) => {
    const ai: any = await client();
    // `as any` at the SDK boundary: request/response types are pinned to the installed SDK
    // version and validated at runtime, not asserted here.
    const res: any = await ai.models.generateContent(req);
    // Carry the reason an answer is empty (finishReason / promptFeedback.blockReason). Previously
    // discarded, which made every empty completion an opaque throw — the adapter reconstructs a
    // meaningful error from these instead.
    return {
      text: res?.text,
      usageMetadata: res?.usageMetadata,
      finishReason: res?.candidates?.[0]?.finishReason,
      blockReason: res?.promptFeedback?.blockReason,
    };
  };

  // The embedding transport, shaped exactly like `generate`: the SDK call and nothing else, so every rule
  // about batching, alignment, truncation and usage lives in the unit-tested adapter rather than here.
  const embedContent: EmbedContentFn =
    opts.embedContent ??
    (async (req: VertexEmbedRequest) => {
      const ai: any = await client();
      const res: any = await ai.models.embedContent(req);
      return { embeddings: res?.embeddings, metadata: res?.metadata };
    });

  const embedModel = opts.embedModel ?? process.env.PALUP_EMBED_MODEL ?? DEFAULT_EMBED_MODEL;
  // Retrieval is asymmetric, so the task type is a PAIR and the old single-valued env cannot express it.
  // An operator who still has it set gets a hard failure rather than having it silently ignored — a
  // deliberately-set-and-quietly-dropped task type is how a corpus ends up embedded on the wrong side,
  // which is exactly the failure class E1's `purpose` field exists to make impossible.
  if (process.env.PALUP_EMBED_TASK_TYPE) {
    throw new Error(
      "createVertexAdapter: PALUP_EMBED_TASK_TYPE is retired — one value cannot express an asymmetric " +
        "corpus/query pair. Set PALUP_EMBED_TASK_TYPE_DOCUMENT and/or PALUP_EMBED_TASK_TYPE_QUERY instead.",
    );
  }
  const embedTaskTypes: Record<EmbedPurpose, string> = {
    document:
      opts.embedTaskTypes?.document ?? process.env.PALUP_EMBED_TASK_TYPE_DOCUMENT ?? DEFAULT_EMBED_TASK_TYPES.document,
    query: opts.embedTaskTypes?.query ?? process.env.PALUP_EMBED_TASK_TYPE_QUERY ?? DEFAULT_EMBED_TASK_TYPES.query,
  };
  const embedMaxBatch =
    opts.embedMaxBatch ??
    positiveIntEnv(process.env.PALUP_EMBED_MAX_BATCH) ??
    maxBatchForEmbedModel(embedModel);
  const embedDimension = opts.embedDimension ?? positiveIntEnv(process.env.PALUP_EMBED_DIMENSION);
  // S2 batch-embed resilience knobs (index-side only; `complete` is unaffected). Defaults keep a
  // production deploy that has never set these three envs from silently changing behaviour: 20s/request,
  // 3 retries with capped exponential backoff, 4 requests in flight — sized for a 50k-product index
  // (`MAX_INDEXED_PRODUCTS`, catalog-index.ts:115) without bursting past per-minute embedding quotas.
  const embedTimeoutMs = positiveIntEnv(process.env.PALUP_EMBED_TIMEOUT_MS) ?? 20000;
  const embedMaxRetries = positiveIntEnv(process.env.PALUP_EMBED_MAX_RETRIES) ?? 3;
  const embedConcurrency = positiveIntEnv(process.env.PALUP_EMBED_CONCURRENCY) ?? 4;

  // The embedding capability is ALWAYS wired here, so a deployed adapter reports `canEmbed === true` and
  // the catalog index job stops reporting `no-embed-capability` (catalog-index.ts:352). A deployment that
  // wants no embedding spend at all does not run the JOB (it is a CLI, never a server route) rather than
  // handing the port a crippled adapter — #188's rule is that absence must mean "this adapter cannot",
  // not "this operator would rather not".
  return new VertexModelAdapter(
    generate,
    { model, ...(thinkingLevel ? { thinkingLevel } : {}), completeTimeoutMs },
    {
      call: embedContent,
      cfg: {
        model: embedModel,
        taskTypes: embedTaskTypes,
        maxBatch: embedMaxBatch,
        timeoutMs: embedTimeoutMs,
        maxRetries: embedMaxRetries,
        concurrency: embedConcurrency,
        ...(embedDimension === undefined ? {} : { outputDimensionality: embedDimension }),
      },
    },
  );
}
