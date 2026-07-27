import type { ModelPort, ModelRequest, ModelResponse } from "@palup/platform-ports";

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
  };
}
export interface GenResponse {
  text?: string;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}
export type GenerateFn = (req: GenRequest) => Promise<GenResponse>;

export interface VertexConfig {
  model: string;
}

export class VertexModelAdapter implements ModelPort {
  constructor(
    private readonly generate: GenerateFn,
    private readonly cfg: VertexConfig,
  ) {}

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
      },
    });

    const text = (res.text ?? "").trim();
    if (!text) throw new Error("vertex: model returned empty completion");

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
}
