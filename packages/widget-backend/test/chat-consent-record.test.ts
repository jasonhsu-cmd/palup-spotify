import { describe, it, expect, vi, afterEach } from "vitest";
import { InMemoryRuntimeStore, createInMemoryVectorStore } from "@palup/platform-ports";
import type { ModelPort, ModelRequest } from "@palup/platform-ports";
import { lookupConsent } from "@palup/state-postgres";
import { buildServer } from "../src/server.js";

// PR-11a — server-side consent-record plumbing, end-to-end: the /consent capture endpoint + the
// signals.ts wiring that replaces the old hardcoded consent.memoryOrdinary/memorySpecial="unknown" with
// a real server-side lookup, feeding `decideMemoryWrite` (widget-memory/src/consent.ts, reused
// UNCHANGED) via the ALREADY-wired remember() call (PR-8). Still fully INERT in real production
// (MEMORY_ADR_ACCEPTED hardcoded false) — every test uses the `memoryEnabled` test seam, honored ONLY
// under a real test runner (see server.ts's own doc comment on that seam).

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

const ENV_KEYS = ["MERCHANT_REGION", "WIDGET_TOKEN_SECRET", "WIDGET_EMBED_KEYS"];
afterEach(() => ENV_KEYS.forEach((k) => delete process.env[k]));

describe("PR-11a — /consent + signals.ts wiring, end-to-end via /chat", () => {
  it("EU (non-US), no consent record → lookup unknown/unknown → decideMemoryWrite denies ordinary + special", async () => {
    process.env.MERCHANT_REGION = "eu";
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "eu-1", message: "I like fragrance-free stuff", signals: { anonId: VALID_ANON_ID } },
    });
    expect(res.statusCode).toBe(200);
    expect(upsertSpy).not.toHaveBeenCalled();
    const log = await store.readAudit({ tenantId: "demo" });
    expect(log.map((r) => r.action)).not.toContain("write.ordinary");
    await app.close();
  });

  it("EU with recorded consent1 (memoryOrdinary='in') → ordinary write allowed", async () => {
    process.env.MERCHANT_REGION = "eu";
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    const consentRes = await app.inject({
      method: "POST",
      url: "/consent",
      payload: { anonId: VALID_ANON_ID, memoryOrdinary: "in", memorySpecial: "unknown" },
    });
    expect(consentRes.statusCode).toBe(200);

    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "eu-2", message: "I like fragrance-free stuff", signals: { anonId: VALID_ANON_ID } },
    });
    expect(res.statusCode).toBe(200);
    expect(upsertSpy).toHaveBeenCalled();
    const log = await store.readAudit({ tenantId: "demo" });
    expect(log.map((r) => r.action)).toContain("write.ordinary");
    await app.close();
  });

  it("US (default region), no record → ordinary ALLOWED (opt-out regime, 'unknown' != 'out')", async () => {
    // MERCHANT_REGION left unset -> defaults to "us" (server.ts).
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "us-1", message: "I like fragrance-free stuff", signals: { anonId: VALID_ANON_ID } },
    });
    expect(res.statusCode).toBe(200);
    expect(upsertSpy).toHaveBeenCalled();
    await app.close();
  });

  it("US with recorded memoryOrdinary='out' → ordinary DENIED", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    await app.inject({
      method: "POST",
      url: "/consent",
      payload: { anonId: VALID_ANON_ID, memoryOrdinary: "out", memorySpecial: "unknown" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "us-2", message: "I like fragrance-free stuff", signals: { anonId: VALID_ANON_ID } },
    });
    expect(res.statusCode).toBe(200);
    expect(upsertSpy).not.toHaveBeenCalled();
    const log = await store.readAudit({ tenantId: "demo" });
    expect(log.map((r) => r.action)).not.toContain("write.ordinary");
    await app.close();
  });

  it("special-category write allowed ONLY when memorySpecial='in', in every region including US", async () => {
    for (const region of ["us", "eu", "uk", "other"]) {
      process.env.MERCHANT_REGION = region;
      const store = new InMemoryRuntimeStore();
      const vector = createInMemoryVectorStore();
      const upsertSpy = vi.spyOn(vector, "upsert");
      const modelPort = distillingModel([{ text: "shopper has a tree-nut allergy" }]);
      const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

      await app.inject({
        method: "POST",
        url: "/consent",
        payload: { anonId: VALID_ANON_ID, memoryOrdinary: "unknown", memorySpecial: "in" },
      });
      const res = await app.inject({
        method: "POST",
        url: "/chat",
        payload: { sessionId: `special-${region}`, message: "I have a tree-nut allergy", signals: { anonId: VALID_ANON_ID } },
      });
      expect(res.statusCode).toBe(200);
      expect(upsertSpy).toHaveBeenCalled();
      const log = await store.readAudit({ tenantId: "demo" });
      expect(log.map((r) => r.action)).toContain("write.special");
      await app.close();
    }
  });

  it("special-category write is STILL denied without memorySpecial='in', even in the US", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    const modelPort = distillingModel([{ text: "shopper has a tree-nut allergy" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    await app.inject({
      method: "POST",
      url: "/consent",
      payload: { anonId: VALID_ANON_ID, memoryOrdinary: "in", memorySpecial: "unknown" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "us-special-denied", message: "I have a tree-nut allergy", signals: { anonId: VALID_ANON_ID } },
    });
    expect(res.statusCode).toBe(200);
    expect(upsertSpy).not.toHaveBeenCalled();
    const log = await store.readAudit({ tenantId: "demo" });
    expect(log.map((r) => r.action)).not.toContain("write.special");
    await app.close();
  });

  it("the consent store is TENANT-SCOPED: tenant A's consent record is invisible to tenant B", async () => {
    process.env.WIDGET_TOKEN_SECRET = "wsecret";
    process.env.WIDGET_EMBED_KEYS = JSON.stringify({ "a-key": "tenant-a", "b-key": "tenant-b" });
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });

    const tokenA = (await app.inject({ method: "GET", url: "/widget/token?key=a-key" })).json().token as string;
    const consentRes = await app.inject({
      method: "POST",
      url: "/consent",
      headers: { authorization: "Bearer " + tokenA },
      payload: { anonId: VALID_ANON_ID, memoryOrdinary: "in", memorySpecial: "in" },
    });
    expect(consentRes.statusCode).toBe(200);

    expect(await lookupConsent(store, { tenantId: "tenant-a", anonId: VALID_ANON_ID })).toEqual({
      memoryOrdinary: "in",
      memorySpecial: "in",
    });
    // Same anonId, DIFFERENT (never-consented-under) tenant — must fail closed, not leak tenant-a's record.
    expect(await lookupConsent(store, { tenantId: "tenant-b", anonId: VALID_ANON_ID })).toEqual({
      memoryOrdinary: "unknown",
      memorySpecial: "unknown",
    });
    await app.close();
  });

  it("client-supplied signals.consent is IGNORED — the server lookup value wins", async () => {
    process.env.MERCHANT_REGION = "eu";
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    // No /consent call was ever made for this subject — but the shopper's OWN client asserts consent.
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: {
        sessionId: "spoof-1",
        message: "I like fragrance-free stuff",
        signals: { anonId: VALID_ANON_ID, consent: { memoryOrdinary: "in", memorySpecial: "in" } },
      },
    });
    expect(res.statusCode).toBe(200);
    // EU + no server-side record ⇒ still denied, proving the client's claimed "in" was never consulted.
    expect(upsertSpy).not.toHaveBeenCalled();
    await app.close();
  });

  describe("POST /consent", () => {
    it("records consent bound to the server-derived subject and returns ok", async () => {
      const store = new InMemoryRuntimeStore();
      const app = await buildServer({ store });
      const res = await app.inject({
        method: "POST",
        url: "/consent",
        payload: { anonId: VALID_ANON_ID, memoryOrdinary: "in", memorySpecial: "out" },
      });
      expect(res.statusCode).toBe(200);
      expect(await lookupConsent(store, { tenantId: "demo", anonId: VALID_ANON_ID })).toEqual({
        memoryOrdinary: "in",
        memorySpecial: "out",
      });
      await app.close();
    });

    it("rejects a missing anonId (400) and records nothing", async () => {
      const store = new InMemoryRuntimeStore();
      const app = await buildServer({ store });
      const res = await app.inject({
        method: "POST",
        url: "/consent",
        payload: { memoryOrdinary: "in", memorySpecial: "out" },
      });
      expect(res.statusCode).toBe(400);
      expect((await store.readAudit({ tenantId: "demo" })).map((r) => r.action)).not.toContain("consent.record");
      await app.close();
    });

    it("rejects an invalid anonId (fails validateAnonId's charset/length bound)", async () => {
      const store = new InMemoryRuntimeStore();
      const app = await buildServer({ store });
      const res = await app.inject({
        method: "POST",
        url: "/consent",
        payload: { anonId: "not-a-valid-anon-id!!", memoryOrdinary: "in", memorySpecial: "out" },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("rejects an invalid consent value (not in the tri-state enum)", async () => {
      const store = new InMemoryRuntimeStore();
      const app = await buildServer({ store });
      const res = await app.inject({
        method: "POST",
        url: "/consent",
        payload: { anonId: VALID_ANON_ID, memoryOrdinary: "yes-please", memorySpecial: "out" },
      });
      expect(res.statusCode).toBe(400);
      expect(await lookupConsent(store, { tenantId: "demo", anonId: VALID_ANON_ID })).toEqual({
        memoryOrdinary: "unknown",
        memorySpecial: "unknown",
      });
      await app.close();
    });

    it("is audited (consent.record)", async () => {
      const store = new InMemoryRuntimeStore();
      const app = await buildServer({ store });
      await app.inject({
        method: "POST",
        url: "/consent",
        payload: { anonId: VALID_ANON_ID, memoryOrdinary: "in", memorySpecial: "out" },
      });
      const log = await store.readAudit({ tenantId: "demo" });
      expect(log.map((r) => r.action)).toContain("consent.record");
      await app.close();
    });
  });
});
