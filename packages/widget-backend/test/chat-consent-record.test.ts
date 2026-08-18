import { describe, it, expect, vi, afterEach } from "vitest";
import { InMemoryRuntimeStore, createInMemoryVectorStore, mintWidgetToken } from "@palup/platform-ports";
import type { ModelPort, ModelRequest } from "@palup/platform-ports";
import { lookupConsent, armKill } from "@palup/state-postgres";
import { subjectNamespace, ERASURE_TOMBSTONE_COLLECTION, tombstoneKey } from "@palup/widget-memory";
import { buildServer } from "../src/server.js";
import { guestTokenHeader } from "./helpers/guest-token.js";

// PR-11a — server-side consent-record plumbing, end-to-end: the /consent capture endpoint + the
// signals.ts wiring that replaces the old hardcoded consent.memoryOrdinary/memorySpecial="unknown" with
// a real server-side lookup, feeding `decideMemoryWrite` (widget-memory/src/consent.ts, reused
// UNCHANGED) via the ALREADY-wired remember() call (PR-8). Still fully INERT in real production
// (MEMORY_ADR_ACCEPTED hardcoded false) — every test uses the `memoryEnabled` test seam, honored ONLY
// under a real test runner (see server.ts's own doc comment on that seam).

const VALID_ANON_ID = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // base32, passes validateAnonId's charset+length bound

// Security review (Finding 2) — the boot guard now asserts on the SAME predicate that actually arms
// memory in-process (`memoryServiceEnabled`), so every test below using the `memoryEnabled` seam must
// also set WIDGET_AUTH_REQUIRED=true or `buildServer` throws. A "demo"-tenant widget token (the SAME
// tenant the unauthenticated RUNTIME_TENANT fallback these tests relied on before) keeps every
// assertion identical to before this change.
const WIDGET_SECRET = "wsecret";
const DEMO_WIDGET_TOKEN = mintWidgetToken(WIDGET_SECRET, "demo", 3_600);
// ADR-0019 task 4/9 — the guest memory subject now comes ONLY from a VERIFIED `x-guest-token` (invariant
// 4), never `body.anonId` / `signals.anonId`. Every case below that used to pin a subject via a client
// anonId now crafts a real guest token for that SAME anonId with this secret instead.
const GUEST_SECRET = "gsecret";

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

const ENV_KEYS = ["MERCHANT_REGION", "WIDGET_TOKEN_SECRET", "WIDGET_EMBED_KEYS", "WIDGET_AUTH_REQUIRED", "PALUP_SECRETS", "GUEST_TOKEN_SECRET"];
afterEach(() => ENV_KEYS.forEach((k) => delete process.env[k]));

describe("PR-11a — /consent + signals.ts wiring, end-to-end via /chat", () => {
  it("EU (non-US), no consent record → lookup unknown/unknown → decideMemoryWrite denies ordinary + special", async () => {
    process.env.MERCHANT_REGION = "eu";
    process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
    process.env.WIDGET_AUTH_REQUIRED = "true";
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "eu-1", message: "I like fragrance-free stuff", signals: { anonId: VALID_ANON_ID }, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(upsertSpy).not.toHaveBeenCalled();
    const log = await store.readAudit({ tenantId: "demo" });
    expect(log.map((r) => r.action)).not.toContain("write.ordinary");
    await app.close();
  });

  it("EU with recorded consent1 (memoryOrdinary='in') → ordinary write allowed", async () => {
    process.env.MERCHANT_REGION = "eu";
    process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
    process.env.WIDGET_AUTH_REQUIRED = "true";
    process.env.GUEST_TOKEN_SECRET = GUEST_SECRET;
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    const consentRes = await app.inject({
      method: "POST",
      url: "/consent",
      headers: guestTokenHeader(GUEST_SECRET, "demo", VALID_ANON_ID),
      payload: { memoryOrdinary: "in", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(consentRes.statusCode).toBe(200);

    const res = await app.inject({
      method: "POST",
      url: "/chat",
      headers: guestTokenHeader(GUEST_SECRET, "demo", VALID_ANON_ID),
      payload: { sessionId: "eu-2", message: "I like fragrance-free stuff", signals: {}, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(upsertSpy).toHaveBeenCalled();
    const log = await store.readAudit({ tenantId: "demo" });
    expect(log.map((r) => r.action)).toContain("write.ordinary");
    await app.close();
  });

  it("US (default region), no record → ordinary ALLOWED (opt-out regime, 'unknown' != 'out')", async () => {
    // MERCHANT_REGION left unset -> defaults to "us" (server.ts).
    process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
    process.env.WIDGET_AUTH_REQUIRED = "true";
    process.env.GUEST_TOKEN_SECRET = GUEST_SECRET;
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    const res = await app.inject({
      method: "POST",
      url: "/chat",
      headers: guestTokenHeader(GUEST_SECRET, "demo", VALID_ANON_ID),
      payload: { sessionId: "us-1", message: "I like fragrance-free stuff", signals: {}, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(upsertSpy).toHaveBeenCalled();
    await app.close();
  });

  it("US with recorded memoryOrdinary='out' → ordinary DENIED", async () => {
    process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
    process.env.WIDGET_AUTH_REQUIRED = "true";
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    await app.inject({
      method: "POST",
      url: "/consent",
      payload: { anonId: VALID_ANON_ID, memoryOrdinary: "out", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "us-2", message: "I like fragrance-free stuff", signals: { anonId: VALID_ANON_ID }, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(upsertSpy).not.toHaveBeenCalled();
    const log = await store.readAudit({ tenantId: "demo" });
    expect(log.map((r) => r.action)).not.toContain("write.ordinary");
    await app.close();
  });

  it("special-category write allowed ONLY when memorySpecial='in', in every region including US", async () => {
    // ADR-0015 Inv 9: a special-category write is refused without a configured encryption key
    // (service.ts, fail closed) — provision one for the "demo" RUNTIME_TENANT so this test still
    // exercises a REAL write.special, not just a refusal.
    process.env.PALUP_SECRETS = JSON.stringify({ demo: { MEMORY_ENCRYPTION_KEY: "test-key-for-demo" } });
    process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
    process.env.WIDGET_AUTH_REQUIRED = "true";
    process.env.GUEST_TOKEN_SECRET = GUEST_SECRET;
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
        headers: guestTokenHeader(GUEST_SECRET, "demo", VALID_ANON_ID),
        payload: { memoryOrdinary: "unknown", memorySpecial: "in", widgetToken: DEMO_WIDGET_TOKEN },
      });
      const res = await app.inject({
        method: "POST",
        url: "/chat",
        headers: guestTokenHeader(GUEST_SECRET, "demo", VALID_ANON_ID),
        payload: { sessionId: `special-${region}`, message: "I have a tree-nut allergy", signals: {}, widgetToken: DEMO_WIDGET_TOKEN },
      });
      expect(res.statusCode).toBe(200);
      expect(upsertSpy).toHaveBeenCalled();
      const log = await store.readAudit({ tenantId: "demo" });
      expect(log.map((r) => r.action)).toContain("write.special");
      await app.close();
    }
  });

  it("special-category write is STILL denied without memorySpecial='in', even in the US", async () => {
    process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
    process.env.WIDGET_AUTH_REQUIRED = "true";
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    const modelPort = distillingModel([{ text: "shopper has a tree-nut allergy" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    await app.inject({
      method: "POST",
      url: "/consent",
      payload: { anonId: VALID_ANON_ID, memoryOrdinary: "in", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "us-special-denied", message: "I have a tree-nut allergy", signals: { anonId: VALID_ANON_ID }, widgetToken: DEMO_WIDGET_TOKEN },
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
    process.env.GUEST_TOKEN_SECRET = GUEST_SECRET;
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });

    const tokenA = (await app.inject({ method: "GET", url: "/widget/token?key=a-key" })).json().token as string;
    const consentRes = await app.inject({
      method: "POST",
      url: "/consent",
      headers: { authorization: "Bearer " + tokenA, ...guestTokenHeader(GUEST_SECRET, "tenant-a", VALID_ANON_ID) },
      payload: { memoryOrdinary: "in", memorySpecial: "in" },
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
    process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
    process.env.WIDGET_AUTH_REQUIRED = "true";
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
        widgetToken: DEMO_WIDGET_TOKEN,
      },
    });
    expect(res.statusCode).toBe(200);
    // EU + no server-side record ⇒ still denied, proving the client's claimed "in" was never consulted.
    expect(upsertSpy).not.toHaveBeenCalled();
    await app.close();
  });

  describe("POST /consent", () => {
    it("records consent bound to the server-derived subject and returns ok", async () => {
      process.env.GUEST_TOKEN_SECRET = GUEST_SECRET;
      const store = new InMemoryRuntimeStore();
      const app = await buildServer({ store });
      const res = await app.inject({
        method: "POST",
        url: "/consent",
        headers: guestTokenHeader(GUEST_SECRET, "demo", VALID_ANON_ID),
        payload: { memoryOrdinary: "in", memorySpecial: "out" },
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
      process.env.GUEST_TOKEN_SECRET = GUEST_SECRET;
      const store = new InMemoryRuntimeStore();
      const app = await buildServer({ store });
      await app.inject({
        method: "POST",
        url: "/consent",
        headers: guestTokenHeader(GUEST_SECRET, "demo", VALID_ANON_ID),
        payload: { memoryOrdinary: "in", memorySpecial: "out" },
      });
      const log = await store.readAudit({ tenantId: "demo" });
      expect(log.map((r) => r.action)).toContain("consent.record");
      await app.close();
    });
  });

  // Review fixes (adversarial pass on PR-11a): /consent is a public, audit-writing endpoint, so it must
  // carry the SAME guards its sibling write endpoints do — a per-IP/per-tenant rate limit (else it floods
  // the immutable audit log) and the operator kill switch (NN#4: a governed audited write must be haltable).
  describe("PR-11a review fixes — /consent write-endpoint guards", () => {
    it("NN#4 — an operator kill switch halts the /consent write: 503, records nothing, no audit entry", async () => {
      const store = new InMemoryRuntimeStore();
      await armKill(store, "global", "operator-halt"); // operator halts the shopper agent for this scope
      const app = await buildServer({ store });
      const res = await app.inject({
        method: "POST",
        url: "/consent",
        payload: { anonId: VALID_ANON_ID, memoryOrdinary: "in", memorySpecial: "in" },
      });
      expect(res.statusCode).toBe(503);
      // The halted write never reached the store — consent stays at the fail-closed default...
      expect(await lookupConsent(store, { tenantId: "demo", anonId: VALID_ANON_ID })).toEqual({
        memoryOrdinary: "unknown",
        memorySpecial: "unknown",
      });
      // ...and nothing was appended to the immutable audit log on its behalf.
      const log = await store.readAudit({ tenantId: "demo" });
      expect(log.map((r) => r.action)).not.toContain("consent.record");
      await app.close();
    });

    it("is rate-limited per IP like the mint endpoints — a same-IP flood past the per-IP cap gets 429", async () => {
      const store = new InMemoryRuntimeStore();
      const app = await buildServer({ store });
      const call = () =>
        app.inject({
          method: "POST",
          url: "/consent",
          payload: { anonId: VALID_ANON_ID, memoryOrdinary: "in", memorySpecial: "out" },
        });
      // RL_IP defaults to 60/window; the 61st same-IP call must be throttled. Loop a little past it.
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
});

// PART A (memory-safety follow-up to #332) — a /consent tier toggle-OFF is treated as "Forget me" for
// THAT TIER ALONE (ADR-0015 "Withdrawal is symmetric" + Inv 9: Consent 1 and Consent 2 are independent —
// turning off HEALTH memory must never wipe ORDINARY memory, and vice-versa). Erases + tombstones via
// `withdrawConsent1`/`withdrawConsent2` (widget-memory/src/erasure.ts), mirroring `/forget`'s use of
// `eraseSubject` above.
describe("PART A — POST /consent tier toggle-OFF erases + tombstones that tier (Inv 9)", () => {
  const GUEST_SECRET = "gsecret-part-a";
  // floorNamespace (identity.ts) isn't part of widget-memory's public surface; it is the documented,
  // stable `${subjectNamespace}::floor` composition (its own doc comment), reconstructed here the same
  // way a direct-vector-seed test has to.
  const floorNs = (tenantId: string, anonId: string) => `${subjectNamespace(tenantId, anonId)}::floor`;

  afterEach(() => {
    delete process.env.GUEST_TOKEN_SECRET;
  });

  it("memoryOrdinary='out' -> withdrawConsent1 erases the subject's ordinary facts and an erasure tombstone lands", async () => {
    process.env.GUEST_TOKEN_SECRET = GUEST_SECRET;
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const app = await buildServer({ store, vectorPort: vector });

    await vector.upsert(subjectNamespace("demo", VALID_ANON_ID), [
      { id: "f1", text: "prefers fragrance-free products", metadata: { class: "ordinary" } },
    ]);
    expect(await vector.query(subjectNamespace("demo", VALID_ANON_ID), { text: "", k: 10 })).toHaveLength(1);

    const res = await app.inject({
      method: "POST",
      url: "/consent",
      headers: guestTokenHeader(GUEST_SECRET, "demo", VALID_ANON_ID),
      payload: { memoryOrdinary: "out", memorySpecial: "unknown" },
    });
    expect(res.statusCode).toBe(200);

    expect(await vector.query(subjectNamespace("demo", VALID_ANON_ID), { text: "", k: 10 })).toEqual([]);
    const tombstone = await store.get({ tenantId: "demo" }, ERASURE_TOMBSTONE_COLLECTION, tombstoneKey(VALID_ANON_ID));
    expect(tombstone).not.toBeNull();
    const log = await store.readAudit({ tenantId: "demo" });
    expect(log.map((r) => r.action)).toContain("consent.withdrawn");
    await app.close();
  });

  it("memorySpecial='out' -> withdrawConsent2 erases the floor-namespace facts + tombstones, and leaves a still-consented ordinary fact untouched (Inv 9 independence)", async () => {
    process.env.GUEST_TOKEN_SECRET = GUEST_SECRET;
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const app = await buildServer({ store, vectorPort: vector });

    await vector.upsert(subjectNamespace("demo", VALID_ANON_ID), [
      { id: "ord-1", text: "prefers fragrance-free products", metadata: { class: "ordinary" } },
    ]);
    await vector.upsert(floorNs("demo", VALID_ANON_ID), [
      { id: "special-1", text: "has a tree-nut allergy", metadata: { class: "special" } },
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/consent",
      headers: guestTokenHeader(GUEST_SECRET, "demo", VALID_ANON_ID),
      payload: { memoryOrdinary: "in", memorySpecial: "out" },
    });
    expect(res.statusCode).toBe(200);

    expect(await vector.query(floorNs("demo", VALID_ANON_ID), { text: "", k: 10 })).toEqual([]);
    // Inv 9 — withdrawing the HEALTH tier alone must not touch the still-consented ordinary fact.
    expect(await vector.query(subjectNamespace("demo", VALID_ANON_ID), { text: "", k: 10 })).toHaveLength(1);
    const tombstone = await store.get({ tenantId: "demo" }, ERASURE_TOMBSTONE_COLLECTION, tombstoneKey(VALID_ANON_ID));
    expect(tombstone).not.toBeNull();
    await app.close();
  });

  it("both tiers 'in' -> no withdraw is called and no erasure tombstone lands", async () => {
    process.env.GUEST_TOKEN_SECRET = GUEST_SECRET;
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const app = await buildServer({ store, vectorPort: vector });
    const deleteById = vi.spyOn(vector, "deleteById");
    const deleteNamespace = vi.spyOn(vector, "deleteNamespace");

    const res = await app.inject({
      method: "POST",
      url: "/consent",
      headers: guestTokenHeader(GUEST_SECRET, "demo", VALID_ANON_ID),
      payload: { memoryOrdinary: "in", memorySpecial: "in" },
    });
    expect(res.statusCode).toBe(200);

    expect(deleteById).not.toHaveBeenCalled();
    expect(deleteNamespace).not.toHaveBeenCalled();
    const tombstone = await store.get({ tenantId: "demo" }, ERASURE_TOMBSTONE_COLLECTION, tombstoneKey(VALID_ANON_ID));
    expect(tombstone).toBeNull();
    const log = await store.readAudit({ tenantId: "demo" });
    expect(log.map((r) => r.action)).not.toContain("consent.withdrawn");
    await app.close();
  });
});
