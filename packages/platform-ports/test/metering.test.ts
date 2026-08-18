import { describe, it, expect } from "vitest";
import { createMeteringModelPort } from "../src/metering.js";
import type { ModelPort } from "../src/model-port.js";
import type { TelemetryPort, TelemetryEvent } from "../src/telemetry-port.js";

function spyTelemetry() {
  const events: Array<{ tenantId: string; event: TelemetryEvent }> = [];
  const port: TelemetryPort = {
    async record(ctx, event) {
      events.push({ tenantId: ctx.tenantId, event });
    },
    async query() {
      return { tenantId: "x", events: 0, inputTokens: 0, outputTokens: 0, latencyP50Ms: null, latencyP95Ms: null, byModel: {} };
    },
  };
  return { events, port };
}

const inner: ModelPort = {
  async complete() {
    return { text: "hi", model: "gemini-x", usage: { inputTokens: 12, outputTokens: 8 } };
  },
};

describe("createMeteringModelPort", () => {
  it("records a model_call event with tokens, model, and the request tenant; passes the response through", async () => {
    let t = 1000;
    const { events, port: telemetry } = spyTelemetry();
    const port = createMeteringModelPort(inner, telemetry, { agentType: "shopper", now: () => (t += 50) });
    const res = await port.complete({ messages: [{ role: "user", content: "hi" }], tenantId: "acme" });
    expect(res.text).toBe("hi"); // passthrough
    expect(events).toHaveLength(1);
    expect(events[0].tenantId).toBe("acme"); // server-derived tenant from req.tenantId
    expect(events[0].event).toMatchObject({ kind: "model_call", model: "gemini-x", inputTokens: 12, outputTokens: 8, agentType: "shopper" });
    expect(events[0].event.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("threads an OPTIONAL construction-time tier onto the model_call event when the caller supplies one", async () => {
    const { events, port: telemetry } = spyTelemetry();
    const port = createMeteringModelPort(inner, telemetry, { agentType: "shopper", tier: "high_stakes" });
    await port.complete({ messages: [], tenantId: "acme" });
    expect(events[0].event.tier).toBe("high_stakes");
  });

  it("omits tier when the caller doesn't supply one (no fabricated default)", async () => {
    const { events, port: telemetry } = spyTelemetry();
    const port = createMeteringModelPort(inner, telemetry, { agentType: "shopper" });
    await port.complete({ messages: [], tenantId: "acme" });
    expect(events[0].event.tier).toBeUndefined();
  });

  it("attributes a missing tenant to 'unknown', never cross-tenant", async () => {
    const { events, port: telemetry } = spyTelemetry();
    const port = createMeteringModelPort(inner, telemetry);
    await port.complete({ messages: [] });
    expect(events[0].tenantId).toBe("unknown");
  });

  it("is FAIL-OPEN — a telemetry failure never breaks the model call", async () => {
    const throwing: TelemetryPort = { async record() { throw new Error("telemetry down"); }, async query() { throw new Error("x"); } };
    const port = createMeteringModelPort(inner, throwing);
    const res = await port.complete({ messages: [], tenantId: "acme" });
    expect(res.text).toBe("hi"); // model response returned despite telemetry failure
  });
});
