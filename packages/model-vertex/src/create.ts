// ⚠️ UNVERIFIED-LIVE: this is the only code that touches the real Vertex/Gemini SDK. It matches
// the @google/genai documented surface as of 2026-07 (Google Cloud docs + googleapis/js-genai),
// but has NOT been executed against a live Vertex endpoint in this environment (no GCP creds).
// The adapter LOGIC it wires is fully unit-tested (vertex-adapter.test.ts). Confirm the exact
// `usageMetadata` field names and the current model id against live Vertex before relying on them.
import {
  VertexModelAdapter,
  type GenerateFn,
  type GenRequest,
} from "./vertex-adapter.js";

export interface CreateVertexOptions {
  project?: string;
  location?: string;
  model?: string;
}

export function isVertexConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLOUD_PROJECT);
}

export function createVertexAdapter(opts: CreateVertexOptions = {}): VertexModelAdapter {
  const project = opts.project ?? process.env.GOOGLE_CLOUD_PROJECT;
  const location = opts.location ?? process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1";
  // Model ids change; keep it env-overridable. Confirm current availability in your Vertex region.
  const model = opts.model ?? process.env.PALUP_MODEL ?? "gemini-2.5-flash";
  if (!project) {
    throw new Error(
      "createVertexAdapter: set GOOGLE_CLOUD_PROJECT (and GOOGLE_CLOUD_LOCATION) or pass opts.project",
    );
  }

  // Lazy dynamic import: importing this package (e.g. in the backend's mock mode) never loads the
  // Google SDK. It resolves+initializes only on the FIRST real Vertex call.
  let clientPromise: Promise<any> | null = null;
  const generate: GenerateFn = async (req: GenRequest) => {
    if (!clientPromise) {
      clientPromise = import("@google/genai").then(
        ({ GoogleGenAI }) => new GoogleGenAI({ vertexai: true, project, location }),
      );
    }
    const ai: any = await clientPromise;
    // `as any` at the SDK boundary: request/response types are pinned to the installed SDK
    // version and validated at runtime, not asserted here.
    const res: any = await ai.models.generateContent(req);
    return { text: res?.text, usageMetadata: res?.usageMetadata };
  };

  return new VertexModelAdapter(generate, { model });
}
