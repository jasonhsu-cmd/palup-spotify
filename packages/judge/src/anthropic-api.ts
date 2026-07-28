// Anthropic direct-API ModelPort — the cross-family judge via an ANTHROPIC_API_KEY (no GCP / Model
// Garden needed). Lazy import so the SDK loads only when an API judge is actually created.
// ⚠️ UNVERIFIED-LIVE until run with a key present.
import type { ModelPort, ModelRequest, ModelResponse } from "@palup/platform-ports";

export interface AnthropicApiOptions {
  model?: string;
  apiKey?: string;
}

export function isAnthropicApiConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export function createAnthropicApiAdapter(opts: AnthropicApiOptions = {}): ModelPort {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const model = opts.model ?? process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8";
  if (!apiKey) throw new Error("anthropic-api: set ANTHROPIC_API_KEY (or pass opts.apiKey)");

  let clientPromise: Promise<any> | null = null;
  return {
    async complete(req: ModelRequest): Promise<ModelResponse> {
      if (!clientPromise) {
        clientPromise = import("@anthropic-ai/sdk").then(
          ({ default: Anthropic }) => new Anthropic({ apiKey }),
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
        // temperature intentionally omitted: newer Claude models (e.g. Opus 4.8) deprecate it.
        system,
        messages,
        // Structured outputs: force schema-valid JSON at the provider (Opus 4.8 / Haiku 4.5 support it).
        ...(req.
            responseSchema
          ? { output_config: { format: { type: "json_schema", schema: req.responseSchema } } }
          : {}),
      });
      const text: string = (resp?.content ?? [])
        .map((b: any) => (typeof b?.text === "string" ? b.text : ""))
        .join("")
        .trim();
      if (!text) throw new Error("anthropic-api: empty completion");
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
