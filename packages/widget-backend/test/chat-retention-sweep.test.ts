import { describe, it, expect, vi } from "vitest";
import { InMemoryRuntimeStore, createInMemoryVectorStore } from "@palup/platform-ports";
import type { ModelPort, ModelRequest, VectorPort } from "@palup/platform-ports";
import { armKill } from "@palup/state-postgres";
import { subjectNamespace } from "@palup/widget-memory";
import { buildServer } from "../src/server.js";

// Closes the retention-sweep gap (ADR-0015 Inv 4 — "expiry is enforced, not aspirational").
// `sweepExpired` (widget-memory/src/retention.ts) had no production caller: TTL-on-read (service.ts
// `recall`) hides an expired fact but never deletes it, which is harmless against the ephemeral dev
// vector store (a process restart wipes it) but becomes "retained indefinitely" against the durable
// Postgres VectorPort adapter, and can defeat consent withdrawal. server.ts's /chat handler now sweeps
// ONLY the subject already being served that turn (`[signals.anonId]`) — opportunistic, no enumeration
// of other subjects, no cron.

const VALID_ANON_ID = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // base32, passes validateAnonId's charset+length bound
const NAMESPACE = subjectNamespace("demo", VALID_ANON_ID); // unauthenticated /chat falls back to the "demo" tenant

function distillingModel(facts: Array<{ text: string }> = []): ModelPort & { calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  return {
    calls,
    async complete(req: ModelRequest) {
      calls.push(req);
      return { text: JSON.stringify({ facts }), model: "spy-distiller" };
    },
  };
}

async function seedExpiredFact(vector: VectorPort, id = "expired-1") {
  await vector.upsert(NAMESPACE, [
    {
      id,
      text: "old fact",
      metadata: { text: "old fact", class: "ordinary", expiresAt: new Date("2020-01-01T00:00:00.000Z").toISOString() },
    },
  ]);
}

describe("POST /chat — opportunistic per-subject retention sweep (ADR-0015 Inv 4)", () => {
  it("physically DELETES an already-expired fact for the subject served this turn, and audits ttl_sweep", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    await seedExpiredFact(vector);

    const app = await buildServer({ store, vectorPort: vector, modelPort: distillingModel(), memoryEnabled: true });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "sweep-1", message: "hello", signals: { anonId: VALID_ANON_ID } },
    });
    expect(res.statusCode).toBe(200);

    // still hidden-not-deleted would show 0 results from recall, but PHYSICALLY present in the raw
    // query — the acceptance bar here is that it is no longer physically present at all.
    const remaining = await vector.query(NAMESPACE, { text: "", k: 10 });
    expect(remaining.map((r) => r.id)).not.toContain("expired-1");

    const log = await store.readAudit({ tenantId: "demo" });
    expect(log.map((r) => r.action)).toContain("ttl_sweep");
    await app.close();
  });

  it("leaves a NOT-yet-expired fact for the same subject untouched", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    await vector.upsert(NAMESPACE, [
      { id: "alive-1", text: "fresh fact", metadata: { text: "fresh fact", class: "ordinary", expiresAt: new Date("2030-01-01T00:00:00.000Z").toISOString() } },
    ]);

    const app = await buildServer({ store, vectorPort: vector, modelPort: distillingModel(), memoryEnabled: true });
    await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "sweep-2", message: "hello", signals: { anonId: VALID_ANON_ID } },
    });

    const remaining = await vector.query(NAMESPACE, { text: "", k: 10 });
    expect(remaining.map((r) => r.id)).toContain("alive-1");
    await app.close();
  });

  it("NEVER fires when memory is off (real inert posture) — the expired fact stays physically present, no ttl_sweep audit", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    await seedExpiredFact(vector);

    const app = await buildServer({ store, vectorPort: vector, modelPort: distillingModel() }); // no memoryEnabled seam
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "sweep-3", message: "hello", signals: { anonId: VALID_ANON_ID } },
    });
    expect(res.statusCode).toBe(200);

    const remaining = await vector.query(NAMESPACE, { text: "", k: 10 });
    expect(remaining.map((r) => r.id)).toContain("expired-1");
    const log = await store.readAudit({ tenantId: "demo" });
    expect(log.map((r) => r.action)).not.toContain("ttl_sweep");
    await app.close();
  });

  it("NEVER fires when no anonId is present on the turn", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    await seedExpiredFact(vector);

    const app = await buildServer({ store, vectorPort: vector, modelPort: distillingModel(), memoryEnabled: true });
    await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "sweep-4", message: "hello", signals: {} }, // no anonId at all
    });

    const remaining = await vector.query(NAMESPACE, { text: "", k: 10 });
    expect(remaining.map((r) => r.id)).toContain("expired-1");
    const log = await store.readAudit({ tenantId: "demo" });
    expect(log.map((r) => r.action)).not.toContain("ttl_sweep");
    await app.close();
  });

  it("NN#4 kill-switch respected — a halted tenant gets no sweep either", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    await seedExpiredFact(vector);
    await armKill(store, "global", "operator-halt");

    const app = await buildServer({ store, vectorPort: vector, modelPort: distillingModel(), memoryEnabled: true });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "sweep-5", message: "hello", signals: { anonId: VALID_ANON_ID } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().flags).toContain("kill_switch");

    const remaining = await vector.query(NAMESPACE, { text: "", k: 10 });
    expect(remaining.map((r) => r.id)).toContain("expired-1");
    const log = await store.readAudit({ tenantId: "demo" });
    expect(log.map((r) => r.action)).not.toContain("ttl_sweep");
    await app.close();
  });

  it("a sweep failure cannot break the shopper's turn (fail-open)", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    await seedExpiredFact(vector);
    vi.spyOn(vector, "deleteById").mockRejectedValue(new Error("simulated vector store failure"));

    const app = await buildServer({ store, vectorPort: vector, modelPort: distillingModel(), memoryEnabled: true });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "sweep-6", message: "hello", signals: { anonId: VALID_ANON_ID } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reply).toBeTruthy();
    await app.close();
  });
});
