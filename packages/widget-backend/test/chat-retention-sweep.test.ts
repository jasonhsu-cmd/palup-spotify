import { describe, it, expect, vi, afterEach } from "vitest";
import { InMemoryRuntimeStore, createInMemoryVectorStore, mintWidgetToken } from "@palup/platform-ports";
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

// Security review (Finding 2) — the boot guard now asserts on the SAME predicate that actually arms
// memory in-process (`memoryServiceEnabled`), so every test below using the `memoryEnabled` seam must
// also set WIDGET_AUTH_REQUIRED=true or `buildServer` throws. A "demo"-tenant widget token (the SAME
// tenant the unauthenticated RUNTIME_TENANT fallback these tests relied on before) keeps every
// assertion identical to before this change.
const WIDGET_SECRET = "wsecret";
const DEMO_WIDGET_TOKEN = mintWidgetToken(WIDGET_SECRET, "demo", 3_600);
const ENV_KEYS = ["WIDGET_TOKEN_SECRET", "WIDGET_AUTH_REQUIRED"];
afterEach(() => ENV_KEYS.forEach((k) => delete process.env[k]));

// Security review (Finding 7) — the sweep is fire-and-forget (server.ts), so a test asserting the
// physical delete happened must not race it: poll with a bounded wait instead of assuming the
// microtask queue drains before `vector.query` runs (true today only incidentally).
async function waitUntil(check: () => Promise<boolean>, timeoutMs = 1_000, intervalMs = 5): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

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
    process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
    process.env.WIDGET_AUTH_REQUIRED = "true";
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    await seedExpiredFact(vector);

    const app = await buildServer({ store, vectorPort: vector, modelPort: distillingModel(), memoryEnabled: true });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "sweep-1", message: "hello", signals: { anonId: VALID_ANON_ID }, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);

    // still hidden-not-deleted would show 0 results from recall, but PHYSICALLY present in the raw
    // query — the acceptance bar here is that it is no longer physically present at all. The sweep is
    // fire-and-forget (server.ts), so poll with a bounded wait rather than assume it already completed
    // the instant `app.inject` resolves (Finding 7 — that assumption is a latent flaky-test race).
    const deleted = await waitUntil(async () => {
      const remaining = await vector.query(NAMESPACE, { text: "", k: 10 });
      return !remaining.some((r) => r.id === "expired-1");
    });
    expect(deleted).toBe(true);

    const log = await store.readAudit({ tenantId: "demo" });
    expect(log.map((r) => r.action)).toContain("ttl_sweep");
    await app.close();
  });

  it("leaves a NOT-yet-expired fact for the same subject untouched", async () => {
    process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
    process.env.WIDGET_AUTH_REQUIRED = "true";
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    await vector.upsert(NAMESPACE, [
      { id: "alive-1", text: "fresh fact", metadata: { text: "fresh fact", class: "ordinary", expiresAt: new Date("2030-01-01T00:00:00.000Z").toISOString() } },
    ]);

    const app = await buildServer({ store, vectorPort: vector, modelPort: distillingModel(), memoryEnabled: true });
    await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "sweep-2", message: "hello", signals: { anonId: VALID_ANON_ID }, widgetToken: DEMO_WIDGET_TOKEN },
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
    process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
    process.env.WIDGET_AUTH_REQUIRED = "true";
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    await seedExpiredFact(vector);

    const app = await buildServer({ store, vectorPort: vector, modelPort: distillingModel(), memoryEnabled: true });
    await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "sweep-4", message: "hello", signals: {}, widgetToken: DEMO_WIDGET_TOKEN }, // no anonId at all
    });

    const remaining = await vector.query(NAMESPACE, { text: "", k: 10 });
    expect(remaining.map((r) => r.id)).toContain("expired-1");
    const log = await store.readAudit({ tenantId: "demo" });
    expect(log.map((r) => r.action)).not.toContain("ttl_sweep");
    await app.close();
  });

  it("NN#4 kill-switch respected — a halted tenant gets no sweep either", async () => {
    process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
    process.env.WIDGET_AUTH_REQUIRED = "true";
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    await seedExpiredFact(vector);
    await armKill(store, "global", "operator-halt");

    const app = await buildServer({ store, vectorPort: vector, modelPort: distillingModel(), memoryEnabled: true });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "sweep-5", message: "hello", signals: { anonId: VALID_ANON_ID }, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().flags).toContain("kill_switch");

    const remaining = await vector.query(NAMESPACE, { text: "", k: 10 });
    expect(remaining.map((r) => r.id)).toContain("expired-1");
    const log = await store.readAudit({ tenantId: "demo" });
    expect(log.map((r) => r.action)).not.toContain("ttl_sweep");
    await app.close();
  });

  it("a sweep failure cannot break the shopper's turn (fail-open), but IS surfaced to the operator (Finding 1 — never silently swallowed)", async () => {
    process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
    process.env.WIDGET_AUTH_REQUIRED = "true";
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    await seedExpiredFact(vector);
    vi.spyOn(vector, "deleteById").mockRejectedValue(new Error("simulated vector store failure"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const app = await buildServer({ store, vectorPort: vector, modelPort: distillingModel(), memoryEnabled: true });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "sweep-6", message: "hello", signals: { anonId: VALID_ANON_ID }, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reply).toBeTruthy();

    // Finding 1 (HIGH) — a swallowed sweep failure must still be visible to an operator: a PII-free
    // signal (count/error class only — never fact text or the raw anonId) reaches the logs rather than
    // vanishing into an empty `.catch(() => {})`. Poll: the failure surfaces asynchronously (fire-and-
    // forget sweep), same rationale as `waitUntil` above.
    const surfaced = await waitUntil(async () =>
      errorSpy.mock.calls.some((args) => args.some((a) => typeof a === "string" && a.includes("ttl_sweep"))),
    );
    expect(surfaced).toBe(true);
    // Never the raw anonId, never fact text — only the tenant, a count, and the error's class.
    const loggedText = errorSpy.mock.calls.flat().filter((a) => typeof a === "string").join(" ");
    expect(loggedText).not.toContain(VALID_ANON_ID);
    expect(loggedText).not.toContain("old fact");
    errorSpy.mockRestore();
    await app.close();
  });

  // Security review (Finding 8, NOTE) — the sliding-TTL-renewal-vs-sweep interaction is exercised as a
  // widget-memory-level regression test instead of an end-to-end /chat one: see
  // packages/widget-memory/test/retention.test.ts's "sliding TTL survives a same-cycle sweep" describe
  // block. Discovered while attempting to write this test AT the /chat level: server.ts's `memoryPort`
  // wrapper (composition root, ~line 280) hardcodes `consent1`/`consent2` to `"unknown"` on every
  // `recall()` call — a structural placeholder the comment there says is fine because "consent is
  // enforced at write time" — but service.ts's recall() ALSO consults `ctx.consent1`/`consent2` to gate
  // the sliding-TTL RENEWAL throttle (Inv 4 amendment, 2026-08-04). With consent hardcoded to "unknown",
  // that renewal can never actually fire through today's real /chat path, even for a subject with a
  // recorded consent1="in". This is a genuine, PRE-EXISTING functional gap, orthogonal to the 12
  // security-review findings this PR closes — NOT fixed here (it needs its own solution-architect design
  // + test-first change to how `signals.consent` is threaded into `memoryPort.recall`, mirroring how
  // `remember()`'s call site already does it two lines below). Flagged here and in the PR/session notes
  // rather than silently left for a future reader to rediscover.
});
