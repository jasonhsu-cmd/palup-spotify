// ⚠️ UNVERIFIED-LIVE until run with access: Claude on Vertex (Anthropic Model Garden) as a
// DIFFERENT-family judge from the Gemini agent runtime. Uses @anthropic-ai/vertex-sdk (lazy import),
// so importing this package never loads the SDK unless a Claude judge is actually created.
// Confirm the current Claude-on-Vertex model id + region for your project in Model Garden.
import type { ModelPort, ModelRequest, ModelResponse } from "@palup/platform-ports";

export interface AnthropicVertexOptions {
  project?: string;
  region?: string;
  model?: string;
}

export function isAnthropicVertexConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLOUD_PROJECT);
}

export function createAnthropicVertexAdapter(opts: AnthropicVertexOptions = {}): ModelPort {
  const project = opts.project ?? process.env.GOOGLE_CLOUD_PROJECT;
  const region = opts.region ?? process.env.ANTHROPIC_VERTEX_REGION ?? "us-east5";
  const model = opts.model ?? process.env.JUDGE_MODEL ?? "claude-sonnet-4-5@20250929";
  if (!project) throw new Error("anthropic-vertex: set GOOGLE_CLOUD_PROJECT");

  let clientPromise: Promise<any> | null = null;
  return {
    async complete(req: ModelRequest): Promise<ModelResponse> {
      if (!clientPromise) {
        clientPromise = import("@anthropic-ai/vertex-sdk").then(
          ({ AnthropicVertex }) => new AnthropicVertex({ projectId: project, region }),
        );
      }
      const client: any = await clientPromise;
      const system =
        req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n") || undefined;
      const messages = req.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));
      const resp: any = await client.messages.create({
        model,
        max_tokens: req.maxTokens ?? 1024,
        temperature: req.temperature ?? 0,
        system,
        messages,
      });
      const text: string = (resp?.content ?? [])
        .map((b: any) => (typeof b?.text === "string" ? b.text : ""))
        .join("")
        .trim();
      if (!text) throw new Error("anthropic-vertex: empty completion");
      return {
        text,
        model,
        usage: resp?.usage
          ? { inputTokens: resp.usage.input_tokens ?? 0, outputTokens: resp.usage.output_tokens ?? 0 }
          : undefined,
      };
    },
  };
}
