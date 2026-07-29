import type { ModelPort, ModelRequest, ModelResponse } from "./model-port.js";
import type { TelemetryPort } from "./telemetry-port.js";

// Metering decorator for the ModelPort (mirrors createRedactingModelPort). This is the single choke
// point for raw inference cost: it sees every model call's token usage + latency + model id, and no
// caller/agent can bypass it. Attribution rides on the SERVER-derived tenant already carried on
// ModelRequest.tenantId (set by the brain from signals.tenantId). Fail-open: metering must never break
// or delay serving — a telemetry failure is swallowed, the model response is returned unchanged.

export function createMeteringModelPort(
  inner: ModelPort,
  telemetry: TelemetryPort,
  opts: { agentType?: string; now?: () => number } = {},
): ModelPort {
  const now = opts.now ?? (() => Date.now());
  return {
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
}
