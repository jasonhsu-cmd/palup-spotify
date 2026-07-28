import { createVertexAdapter } from "@palup/model-vertex";
import { ModelJudge } from "./model-judge.js";
import { createAnthropicVertexAdapter } from "./anthropic-vertex.js";
import { createAnthropicApiAdapter } from "./anthropic-api.js";

export { ModelJudge } from "./model-judge.js";
export { crossFamilyGuard, type CrossFamilyResult } from "./guard.js";
export {
  createAnthropicVertexAdapter,
  isAnthropicVertexConfigured,
  type AnthropicVertexOptions,
} from "./anthropic-vertex.js";
export {
  createAnthropicApiAdapter,
  isAnthropicApiConfigured,
  type AnthropicApiOptions,
} from "./anthropic-api.js";

/** Same family as the Gemini agent — use only as an ADVISORY judge (fails the cross-family guard). */
export function createGeminiJudge(model?: string): ModelJudge {
  return new ModelJudge(createVertexAdapter(model ? { model } : {}), "gemini");
}

/** Cross-family judge via the Anthropic direct API (ANTHROPIC_API_KEY). No GCP needed. */
export function createAnthropicApiJudge(model?: string): ModelJudge {
  return new ModelJudge(createAnthropicApiAdapter(model ? { model } : {}), "anthropic");
}

/** Cross-family judge via Claude on Vertex (Model Garden). Needs Claude enabled in the project. */
export function createAnthropicJudge(model?: string): ModelJudge {
  return new ModelJudge(createAnthropicVertexAdapter(model ? { model } : {}), "anthropic");
}
