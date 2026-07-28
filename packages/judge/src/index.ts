import { createVertexAdapter } from "@palup/model-vertex";
import { ModelJudge } from "./model-judge.js";
import { createAnthropicVertexAdapter } from "./anthropic-vertex.js";

export { ModelJudge } from "./model-judge.js";
export { crossFamilyGuard, type CrossFamilyResult } from "./guard.js";
export {
  createAnthropicVertexAdapter,
  isAnthropicVertexConfigured,
  type AnthropicVertexOptions,
} from "./anthropic-vertex.js";

/** Same family as the Gemini agent — use only as an ADVISORY judge (fails the cross-family guard). */
export function createGeminiJudge(model?: string): ModelJudge {
  return new ModelJudge(createVertexAdapter(model ? { model } : {}), "gemini");
}

/** Different family (Claude on Vertex) — the true cross-family judge for a Gemini agent runtime. */
export function createAnthropicJudge(model?: string): ModelJudge {
  return new ModelJudge(createAnthropicVertexAdapter(model ? { model } : {}), "anthropic");
}
