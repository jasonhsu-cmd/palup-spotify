import { describe, it, expect, vi } from "vitest";
import { InMemoryRuntimeStore, createInMemoryVectorStore } from "@palup/platform-ports";
import type { ModelPort, ModelRequest } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";

// Shopper-disposition program PR-8 — persistence wiring: `remember()` is now called POST-DECISION on
// the /chat clean path (previously it was never called anywhere). Still fully INERT in real production
// (MEMORY_ADR_ACCEPTED is hardcoded false, flag.ts) — every test here uses the `memoryEnabled` test seam
// (mirrors createMemoryService's own `enabled` seam), which is honored ONLY under a real test runner
// (see server.ts's own doc comment), so it can never flip memory on in production.

const VALID_ANON_ID = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // base32, passes validateAnonId's charset+length bound

function distillingModel(facts: Array<{ text: string }>): ModelPort & { calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  return {
    calls,
    async complete(req: ModelRequest) {
      calls.push(req);
      // The SAME mock backs both the brain's own reply-generation call AND the memory distiller's
      // extraction call in this test (server.ts derives both from the one injected modelPort) — a
      // valid distill-JSON response is harmless as a "reply" too, since these tests don't assert on
      // reply content.
      return { text: JSON.stringify({ facts }), model: "spy-distiller" };
    },
  };
}

describe("PR-8 — remember() wired into /chat, post-decision, on the clean path", () => {
  it("an ordinary distilled fact is written to the vector port and audited (write.ordinary) — remember() really was called", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);

    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: {
        sessionId: "mem-remember-1",
        message: "I like fragrance-free stuff",
        signals: { cart: "empty", anonId: VALID_ANON_ID },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(upsertSpy).toHaveBeenCalled();
    const log = await store.readAudit({ tenantId: "demo" });
    expect(log.map((r) => r.action)).toContain("write.ordinary");
    await app.close();
  });

  it("is NEVER called on the early-return validation path (e.g. an oversized message) — no memory-service call before a real decision exists", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    const modelPort = distillingModel([{ text: "x" }]);

    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: {
        sessionId: "mem-remember-2",
        message: "a".repeat(5_000), // over MAX_MESSAGE_CHARS (default 4000) -> 400 input_rejected, no decision made
        signals: { cart: "empty", anonId: VALID_ANON_ID },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().flags).toContain("input_rejected");
    expect(upsertSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it("consent gate honored: a special-category candidate is classified + gated INSIDE remember() and never written (Consent 2 is hardcoded 'unknown' — PR-11 blocker, still unresolved)", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    const modelPort = distillingModel([{ text: "shopper has a tree-nut allergy" }]);

    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: {
        sessionId: "mem-remember-3",
        message: "I have a tree-nut allergy",
        signals: { cart: "empty", anonId: VALID_ANON_ID },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(upsertSpy).not.toHaveBeenCalled(); // Consent 2 required, and it's hardcoded "unknown" -> denied
    const log = await store.readAudit({ tenantId: "demo" });
    expect(log.map((r) => r.action)).not.toContain("write.special");
    expect(log.map((r) => r.action)).not.toContain("write.ordinary");
    await app.close();
  });

  it("no subject key (no anonId) -> remember() is never even attempted, mirroring the brain's own recall guard", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);

    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: {
        sessionId: "mem-remember-4",
        message: "I like fragrance-free stuff",
        signals: { cart: "empty" }, // no anonId at all
      },
    });

    expect(res.statusCode).toBe(200);
    expect(upsertSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it("PR-6 Finding H — the model threaded into the memory service is redaction-wrapped: a pasted card/SSN in the shopper turn never reaches the model port", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);

    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: {
        sessionId: "mem-redact-1",
        message: "my card is 4111 1111 1111 1111, please use it on file",
        signals: { cart: "empty", anonId: VALID_ANON_ID },
      },
    });
    expect(res.statusCode).toBe(200);

    // The distiller is the ONLY call site in this composition that sets `responseSchema` (the brain's
    // own reply-generation call and the SUBSCRIPTION_SELFSERVE/classifier paths don't run in this test),
    // so this reliably isolates the memory-service's OWN model call from the brain's own (separately,
    // already redaction-wrapped in real production via model.ts — irrelevant to this assertion).
    const distillCalls = modelPort.calls.filter((c) => c.responseSchema !== undefined);
    expect(distillCalls.length).toBeGreaterThan(0); // the distiller really was invoked
    for (const call of distillCalls) {
      const userContent = call.messages
        .filter((m) => m.role !== "system")
        .map((m) => m.content)
        .join(" ");
      expect(userContent).not.toContain("4111");
      expect(userContent).toContain("[redacted-card]");
    }
    await app.close();
  });

  it("still fully INERT unless BOTH memory flags are on: memoryEnabled NOT passed -> remember() never runs even with a live modelPort/vectorPort injected", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);

    const app = await buildServer({ store, vectorPort: vector, modelPort }); // no memoryEnabled seam
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: {
        sessionId: "mem-inert-remember-1",
        message: "I like fragrance-free stuff",
        signals: { cart: "empty", anonId: VALID_ANON_ID },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(upsertSpy).not.toHaveBeenCalled();
    // Only ONE call recorded (the brain's own reply generation) — the distiller was never invoked.
    expect(modelPort.calls.filter((c) => c.responseSchema !== undefined)).toHaveLength(0);
    await app.close();
  });

  it("the memoryEnabled test seam itself is honored ONLY under a real test runner — in production it is IGNORED (NN#1)", async () => {
    const orig = { v: process.env.VITEST, n: process.env.NODE_ENV };
    delete process.env.VITEST;
    process.env.NODE_ENV = "production";
    try {
      const store = new InMemoryRuntimeStore();
      const vector = createInMemoryVectorStore();
      const upsertSpy = vi.spyOn(vector, "upsert");
      const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);

      const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });
      const res = await app.inject({
        method: "POST",
        url: "/chat",
        payload: {
          sessionId: "mem-prod-seam-1",
          message: "I like fragrance-free stuff",
          signals: { cart: "empty", anonId: VALID_ANON_ID },
        },
      });
      expect(res.statusCode).toBe(200);
      // MEMORY_ADR_ACCEPTED is hardcoded false — the test seam is ignored outside a test runner, so
      // memory stays inert even though memoryEnabled:true was explicitly passed.
      expect(upsertSpy).not.toHaveBeenCalled();
      await app.close();
    } finally {
      if (orig.v === undefined) delete process.env.VITEST;
      else process.env.VITEST = orig.v;
      process.env.NODE_ENV = orig.n as string;
    }
  });
});
