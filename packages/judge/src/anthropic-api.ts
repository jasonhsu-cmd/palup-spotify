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
  const model = opts.model ?? process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
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
        temperature: req.temperature ?? 0,
        system,
        messages,
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
