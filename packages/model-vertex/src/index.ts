export { VertexModelAdapter } from "./vertex-adapter.js";
export {
  DEFAULT_EMBED_MODEL,
  DEFAULT_EMBED_TASK_TYPE,
  maxBatchForEmbedModel,
} from "./vertex-adapter.js";
export type {
  GenerateFn,
  GenRequest,
  GenResponse,
  GenContent,
  VertexConfig,
  EmbedContentFn,
  VertexEmbedRequest,
  VertexEmbedResponse,
  VertexEmbedConfig,
  VertexEmbedding,
} from "./vertex-adapter.js";
export { createVertexAdapter, isVertexConfigured, type CreateVertexOptions } from "./create.js";
