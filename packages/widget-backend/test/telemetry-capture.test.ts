import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore, createStoreTelemetry, type TelemetryEvent } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";

// M3 slices 2+3: a /chat turn is metered end-to-end — model_call event(s) from the decorator + one
// per-turn enrichment event — under the server-derived tenant, without breaking serving.
describe("telemetry capture on /chat", () => {
  it("records model_call + turn events under the request tenant", async () => {
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });
    const res = await app.inject({ method: "POST", url: "/chat", payload: { sessionId: "tel-1", message: "what do you recommend for dark circles?", signals: { cart: "has_items" } } });
    expect(res.statusCode).toBe(200);

    // Unauthenticated ⇒ fallback tenant "demo".
    const events = await store.readStream<TelemetryEvent>({ tenantId: "demo" }, "telemetry");
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("turn"); // per-turn enrichment
    expect(kinds).toContain("model_call"); // metered model call(s)

    const turn = events.find((e) => e.kind === "turn")!;
    expect(turn.servedBy).toBeTruthy();
    expect(turn.mode).toBeTruthy();
    expect(typeof turn.latencyMs).toBe("number");
    // PII-free across the WHOLE stream (both model_call AND turn events): no shopper message text.
    expect(JSON.stringify(events)).not.toContain("dark circles");
    expect(JSON.stringify(events).toLowerCase()).not.toContain("circles");

    // Rollup is queryable and tenant-scoped.
    const rollup = await createStoreTelemetry(store).query({ tenantId: "demo" });
    expect(rollup.events).toBeGreaterThanOrEqual(2);
    expect(await createStoreTelemetry(store).query({ tenantId: "someone-else" })).toMatchObject({ events: 0 });
    await app.close();
  });
});
