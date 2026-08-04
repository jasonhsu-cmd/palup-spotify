import { describe, it, expect, vi, afterEach } from "vitest";
import { InMemoryRuntimeStore, createInMemoryVectorStore } from "@palup/platform-ports";
import type { ModelPort, ModelRequest } from "@palup/platform-ports";
import { armKill } from "@palup/state-postgres";
import { buildServer } from "../src/server.js";

// PR-11b — POST /forget: the data-RIGHTS erasure endpoint (widget-memory/src/erasure.ts's `eraseSubject`,
// reused unchanged). Same (tenantId, anonId) derivation + guards as /consent (chat-consent-record.test.ts):
// tenant from the verified widget token (falling back to RUNTIME_TENANT), validateAnonId charset/length
// bound, per-IP + per-tenant rate limit, NN#4 kill-switch. Unlike /consent, it must WORK regardless of the
// double gate (a shopper's right to erase does not depend on the feature's current on/off state) — the
// "works regardless" test below builds TWO server instances sharing the same store+vector, one with the
// memoryEnabled seam (to write a fact) and one WITHOUT it (the real-production default), proving /forget
// on the second instance still erases what the first wrote.

const VALID_ANON_ID = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // base32, passes validateAnonId's charset+length bound

function distillingModel(facts: Array<{ text: string }>): ModelPort & { calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  return {
    calls,
    async complete(req: ModelRequest) {
      calls.push(req);
      return { text: JSON.stringify({ facts }), model: "spy-distiller" };
    },
  };
}

const ENV_KEYS = ["WIDGET_TOKEN_SECRET", "WIDGET_EMBED_KEYS"];
afterEach(() => ENV_KEYS.forEach((k) => delete process.env[k]));

describe("POST /forget", () => {
  it("rejects a missing anonId (400) and erases nothing", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const deleteSpy = vi.spyOn(vector, "deleteNamespace");
    const app = await buildServer({ store, vectorPort: vector });
    const res = await app.inject({ method: "POST", url: "/forget", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(deleteSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects an invalid anonId (fails validateAnonId's charset/length bound)", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const deleteSpy = vi.spyOn(vector, "deleteNamespace");
    const app = await buildServer({ store, vectorPort: vector });
    const res = await app.inject({ method: "POST", url: "/forget", payload: { anonId: "not-valid!!" } });
    expect(res.statusCode).toBe(400);
    expect(deleteSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it("erases a subject's stored fact and audits erase.subject (no raw anonId in the audit trail)", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "forget-1", message: "I like fragrance-free stuff", signals: { anonId: VALID_ANON_ID } },
    });
    expect((await vector.query("demo::" + VALID_ANON_ID, { text: "", k: 10 })).length).toBeGreaterThan(0);

    const res = await app.inject({ method: "POST", url: "/forget", payload: { anonId: VALID_ANON_ID } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect((await vector.query("demo::" + VALID_ANON_ID, { text: "", k: 10 })).length).toBe(0);

    const log = await store.readAudit({ tenantId: "demo" });
    expect(log.map((r) => r.action)).toContain("erase.subject");
    expect(JSON.stringify(log)).not.toContain(VALID_ANON_ID);
    await app.close();
  });

  it("no-ops safely when nothing was ever stored for this subject", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const app = await buildServer({ store, vectorPort: vector });
    const res = await app.inject({ method: "POST", url: "/forget", payload: { anonId: VALID_ANON_ID } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });

  it("works regardless of memoryEnabled: a memory-DISABLED instance sharing the same store+vector can still erase what a memory-ENABLED instance wrote", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const writerApp = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });
    await writerApp.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "forget-2", message: "I like fragrance-free stuff", signals: { anonId: VALID_ANON_ID } },
    });
    expect((await vector.query("demo::" + VALID_ANON_ID, { text: "", k: 10 })).length).toBeGreaterThan(0);
    await writerApp.close();

    // A fresh app instance sharing the SAME store+vector, this time WITHOUT the memoryEnabled seam — the
    // real-production posture (double gate off).
    const disabledApp = await buildServer({ store, vectorPort: vector });
    const res = await disabledApp.inject({ method: "POST", url: "/forget", payload: { anonId: VALID_ANON_ID } });
    expect(res.statusCode).toBe(200);
    expect((await vector.query("demo::" + VALID_ANON_ID, { text: "", k: 10 })).length).toBe(0);
    await disabledApp.close();
  });

  it("is tenant-scoped: tenant B's /forget cannot erase tenant A's data for the same anonId", async () => {
    process.env.WIDGET_TOKEN_SECRET = "wsecret";
    process.env.WIDGET_EMBED_KEYS = JSON.stringify({ "a-key": "tenant-a", "b-key": "tenant-b" });
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    const tokenA = (await app.inject({ method: "GET", url: "/widget/token?key=a-key" })).json().token as string;
    const tokenB = (await app.inject({ method: "GET", url: "/widget/token?key=b-key" })).json().token as string;

    await app.inject({
      method: "POST",
      url: "/chat",
      headers: { authorization: "Bearer " + tokenA },
      payload: { sessionId: "forget-3", message: "I like fragrance-free stuff", signals: { anonId: VALID_ANON_ID } },
    });
    expect((await vector.query("tenant-a::" + VALID_ANON_ID, { text: "", k: 10 })).length).toBeGreaterThan(0);

    const res = await app.inject({
      method: "POST",
      url: "/forget",
      headers: { authorization: "Bearer " + tokenB },
      payload: { anonId: VALID_ANON_ID },
    });
    expect(res.statusCode).toBe(200);
    expect((await vector.query("tenant-a::" + VALID_ANON_ID, { text: "", k: 10 })).length).toBeGreaterThan(0);
    await app.close();
  });

  it("NN#4 — an operator kill switch halts /forget: 503, nothing erased, no audit entry", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });
    await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "forget-4", message: "I like fragrance-free stuff", signals: { anonId: VALID_ANON_ID } },
    });
    expect((await vector.query("demo::" + VALID_ANON_ID, { text: "", k: 10 })).length).toBeGreaterThan(0);

    await armKill(store, "global", "operator-halt");
    const res = await app.inject({ method: "POST", url: "/forget", payload: { anonId: VALID_ANON_ID } });
    expect(res.statusCode).toBe(503);
    expect((await vector.query("demo::" + VALID_ANON_ID, { text: "", k: 10 })).length).toBeGreaterThan(0);
    const log = await store.readAudit({ tenantId: "demo" });
    expect(log.map((r) => r.action)).not.toContain("erase.subject");
    await app.close();
  });

  it("is rate-limited per IP like /consent — a same-IP flood past the per-IP cap gets 429", async () => {
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });
    const call = () => app.inject({ method: "POST", url: "/forget", payload: { anonId: VALID_ANON_ID } });
    let got429 = false;
    for (let i = 0; i < 65; i++) {
      const r = await call();
      if (r.statusCode === 429) {
        got429 = true;
        break;
      }
    }
    expect(got429).toBe(true);
    await app.close();
  });
});
