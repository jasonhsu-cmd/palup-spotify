// ⚠️ UNVERIFIED-LIVE: this is the only code that touches the real Vertex/Gemini SDK. It matches
// the @google/genai documented surface as of 2026-07 (Google Cloud docs + googleapis/js-genai), and the
// embedding path below was written against the SAME SDK's shipped types + the Vertex embeddings docs
// (citations [E1]–[E5] in vertex-adapter.ts, retrieved 2026-08-06), but NEITHER path has been executed
// against a live Vertex endpoint in this environment (no GCP creds). The adapter LOGIC both wire in is
// fully unit-tested (vertex-adapter.test.ts, vertex-embed.test.ts). Confirm the exact `usageMetadata` /
// `embeddings[].statistics` field names, the current model ids, and the REAL vector dimension against
// live Vertex before relying on them — `pnpm model:smoke` is the command that does it.
import {
  DEFAULT_EMBED_MODEL,
  DEFAULT_EMBED_TASK_TYPE,
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
  /** Embedding model id; defaults to PALUP_EMBED_MODEL, then DEFAULT_EMBED_MODEL. */
  embedModel?: string;
  /** Provider task type; defaults to PALUP_EMBED_TASK_TYPE, then DEFAULT_EMBED_TASK_TYPE. */
  embedTaskType?: string;
  /** Texts per provider request; defaults to PALUP_EMBED_MAX_BATCH, then the per-model documented cap. */
  embedMaxBatch?: number;
  /** `outputDimensionality`; defaults to PALUP_EMBED_DIMENSION, else unset (the model's full length). */
  embedDimension?: number;
  /** Injected embedding transport — TESTS ONLY. Production leaves it unset and gets the real SDK call. */
  embedContent?: EmbedContentFn;
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
  // PALUP_MODEL=gemini-2.5-flash (.github/workflows/deploy-staging.yml). The live end-to-end call
  // against that endpoint is NOT independently verified in this repo (see the UNVERIFIED-LIVE header
  // above); some models/regions differ — override via GOOGLE_CLOUD_LOCATION. The embeddings docs' own
  // Node.js sample also pairs GOOGLE_CLOUD_LOCATION=global with gemini-embedding-001 ([E1]).
  const location = opts.location ?? process.env.GOOGLE_CLOUD_LOCATION ?? "global";
  // Model ids change; keep it env-overridable. Confirm availability for your project/region in
  // Model Garden. (gemini-2.5-flash was GA as of 2026-07 with a retirement date of 2026-10-16.)
  const model = opts.model ?? process.env.PALUP_MODEL ?? "gemini-2.5-flash";
  if (!project) {
    throw new Error(
      "createVertexAdapter: set GOOGLE_CLOUD_PROJECT (and GOOGLE_CLOUD_LOCATION) or pass opts.project",
    );
  }

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
    return { text: res?.text, usageMetadata: res?.usageMetadata };
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
  const embedTaskType =
    opts.embedTaskType ?? process.env.PALUP_EMBED_TASK_TYPE ?? DEFAULT_EMBED_TASK_TYPE;
  const embedMaxBatch =
    opts.embedMaxBatch ??
    positiveIntEnv(process.env.PALUP_EMBED_MAX_BATCH) ??
    maxBatchForEmbedModel(embedModel);
  const embedDimension = opts.embedDimension ?? positiveIntEnv(process.env.PALUP_EMBED_DIMENSION);

  // The embedding capability is ALWAYS wired here, so a deployed adapter reports `canEmbed === true` and
  // the catalog index job stops reporting `no-embed-capability` (catalog-index.ts:352). A deployment that
  // wants no embedding spend at all does not run the JOB (it is a CLI, never a server route) rather than
  // handing the port a crippled adapter — #188's rule is that absence must mean "this adapter cannot",
  // not "this operator would rather not".
  return new VertexModelAdapter(
    generate,
    { model },
    {
      call: embedContent,
      cfg: {
        model: embedModel,
        taskType: embedTaskType,
        maxBatch: embedMaxBatch,
        ...(embedDimension === undefined ? {} : { outputDimensionality: embedDimension }),
      },
    },
  );
}
