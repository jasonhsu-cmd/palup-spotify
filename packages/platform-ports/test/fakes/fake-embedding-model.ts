import { requireEmbedInputs, requireEmbedAlignment } from "../../src/model-port.js";
import type { EmbedRequest, EmbedResponse, ModelPort } from "../../src/model-port.js";

// TEST FAKE — deterministic, offline, no network and no credentials.
//
// HONESTY: this proves the CONTRACT'S SHAPE (batch alignment, dimension reporting, fail-closed input
// validation, usage reporting), NOT any real embedding service's behaviour. Its vectors are char-code
// buckets, so it says NOTHING about semantic quality: whether "something for redness that won't sting"
// actually retrieves a ceramide cream can only be shown against the real Vertex text-embedding model,
// which this environment has no credentials to call. Do not read a passing contract run as evidence that
// semantic retrieval works.
export function fakeEmbeddingPort(opts: { dimension?: number; usage?: boolean; model?: string } = {}): ModelPort {
  const dimension = opts.dimension ?? 8;
  return {
    async complete() {
      return { text: "ok", model: opts.model ?? "fake-embedding-1" };
    },
    async embed(req: EmbedRequest): Promise<EmbedResponse> {
      requireEmbedInputs(req); // every adapter calls this — one shared fail-closed rule
      const vectors = req.texts.map((t) => {
        const v = new Array<number>(dimension).fill(0);
        for (let i = 0; i < t.length; i++) {
          const slot = i % dimension;
          v[slot] = (v[slot] ?? 0) + t.charCodeAt(i);
        }
        return v;
      });
      const res: EmbedResponse = {
        vectors,
        dimension,
        model: opts.model ?? "fake-embedding-1",
        // A fake has no asymmetric behaviour to fake, so it honours the request by echoing it. What that
        // exercises is the CONTRACT (the caller can always read back which side it got), not a provider.
        purpose: req.purpose,
        ...(opts.usage ? { usage: { inputTokens: req.texts.join(" ").length } } : {}),
      };
      requireEmbedAlignment(req, res); // adapters self-check before returning
      return res;
    },
  };
}

/** A complete-only adapter: the capability is ABSENT (embed omitted), never a stub that throws. */
export const completeOnlyPort: ModelPort = {
  async complete() {
    return { text: "ok", model: "complete-only" };
  },
};
