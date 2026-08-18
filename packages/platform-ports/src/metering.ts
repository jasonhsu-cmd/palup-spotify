import type { EmbedRequest, EmbedResponse, ModelPort, ModelRequest, ModelResponse } from "./model-port.js";
import type { ModelTier, TelemetryPort } from "./telemetry-port.js";

// Metering decorator for the ModelPort (mirrors createRedactingModelPort). This is the single choke
// point for raw inference cost: it sees every model call's token usage + latency + model id, and no
// caller/agent can bypass it. Attribution rides on the SERVER-derived tenant already carried on
// ModelRequest.tenantId (set by the brain from signals.tenantId). Fail-open: metering must never break
// or delay serving — a telemetry failure is swallowed, the model response is returned unchanged.
//
// The optional `embed` is metered through the SAME choke point and the SAME `kind: "model_call"` event —
// an embedding IS a metered model call, and the event's `model` field (the embedding model's own id)
// separates embedding spend from completion spend in the rollup without a new event kind. So embedding
// COGS and latency are observable the moment an embedding adapter exists, with no new interface: the
// existing price table prices it by model name (an unpriced embedding model surfaces as UNPRICED and
// flagged, never a fabricated $0 — telemetry-cost.ts), and deriveCostUsd needs no change.

export function createMeteringModelPort(
  inner: ModelPort,
  telemetry: TelemetryPort,
  // `tier` is OPTIONAL and construction-time, mirroring `agentType`: nothing wires a real value yet (the
  // model gateway that would pick a tier per call is design-only — docs/design/model-gateway.md), so a
  // caller that doesn't supply one gets byte-identical events to before this field existed.
  opts: { agentType?: string; tier?: ModelTier; now?: () => number } = {},
): ModelPort {
  const now = opts.now ?? (() => Date.now());
  // Bound, so a class-based adapter (e.g. VertexModelAdapter) keeps its `this`.
  const innerEmbed = inner.embed?.bind(inner);
  const port: ModelPort = {
    async complete(req: ModelRequest): Promise<ModelResponse> {
      const start = now();
      // If the model call itself throws, we do NOT meter here — the error is handled by the caller's
      // degrade path; a failed call consumed no output tokens. (Failure telemetry is a later refinement.)
      const res = await inner.complete(req);
      const tenantId = req.tenantId || "unknown"; // never cross-tenant; unattributed → "unknown"
      void telemetry
        .record(
          { tenantId },
          {
            kind: "model_call",
            agentType: opts.agentType,
            tier: opts.tier,
            model: res.model,
            inputTokens: res.usage?.inputTokens,
            outputTokens: res.usage?.outputTokens,
            latencyMs: now() - start,
          },
        )
        .catch(() => {});
      return res;
    },
  };
  // Forwarded ONLY when the inner adapter really has the capability — never dropped (a caller would read
  // "cannot embed" from an adapter that can), never fabricated (a throwing stub makes an absence look
  // like a failure).
  if (innerEmbed) {
    port.embed = async (req: EmbedRequest): Promise<EmbedResponse> => {
      const start = now();
      const res = await innerEmbed(req); // a failed embed is not metered, mirroring complete
      const tenantId = req.tenantId || "unknown";
      void telemetry
        .record(
          { tenantId },
          {
            kind: "model_call",
            agentType: opts.agentType,
            tier: opts.tier,
            model: res.model,
            inputTokens: res.usage?.inputTokens,
            // No outputTokens: an embedding call produces no completion tokens, and a 0 here would be a
            // fabricated number rather than an absent one.
            latencyMs: now() - start,
          },
        )
        .catch(() => {});
      return res;
    };
  }
  return port;
}
