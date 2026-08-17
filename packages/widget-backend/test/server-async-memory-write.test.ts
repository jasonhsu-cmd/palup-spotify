import { describe, it, expect, afterEach } from "vitest";
import { InMemoryRuntimeStore, createInMemoryVectorStore, mintWidgetToken } from "@palup/platform-ports";
import type { ModelPort, ModelRequest, VectorPort } from "@palup/platform-ports";
import { armKill } from "@palup/state-postgres";
import { buildServer } from "../src/server.js";
import { guestTokenHeader } from "./helpers/guest-token.js";

// semantic-memory-v1, PR2 (write path), T6 — async fire-and-forget write. TODAY (before this PR's
// implementation), server.ts:2437 does `await memoryService.remember(...)` directly on the /chat
// response path (confirmed: server.ts's own comment at that call site — "Never blocks or breaks the
// response" is the INTENT, but the code does not yet honor it structurally: a `remember()` that never
// resolves genuinely blocks the reply today). This file pins the ACCEPTANCE CRITERION: a hung write must
// never hang the shopper's reply.
//
// `vectorPort.upsert` never resolving is how we simulate "a memory service whose remember() never
// resolves" — buildServer has no `distiller`/`memoryService` injection seam (only `store` / `modelPort` /
// `vectorPort`), so the most faithful, least-invasive way to make `remember()` hang without touching any
// other code path is to hang the ONE vector-port op `remember()` itself calls to persist
// (`deps.vector.upsert`, service.ts:328/342) — `query`/`list`/`deleteById`/`deleteNamespace` are left
// fully functional so nothing else on this path (e.g. the opportunistic `sweepExpired`, already
// fire-and-forget via `void ...catch()`) is perturbed.

const WIDGET_SECRET = "wsecret";
const DEMO_WIDGET_TOKEN = mintWidgetToken(WIDGET_SECRET, "demo", 3_600);
const VALID_ANON_ID = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const GUEST_SECRET = "gsecret";
const ENV_KEYS = ["WIDGET_TOKEN_SECRET", "WIDGET_AUTH_REQUIRED", "GUEST_TOKEN_SECRET"];
afterEach(() => ENV_KEYS.forEach((k) => delete process.env[k]));

/** A valid distill-JSON reply so the memory distiller (real `createModelDistiller`, since `buildServer`
 *  has no `distiller` seam) has something to work with, and a harmless reply for the brain's own call. */
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

/** Wraps a real in-memory VectorPort but replaces `upsert` with a promise that NEVER resolves — the
 *  narrowest possible simulation of "the write never comes back", isolated to exactly the op `remember()`
 *  persists through. */
function vectorPortWithHungUpsert(): VectorPort {
  const real = createInMemoryVectorStore();
  return {
    ...real,
    upsert: () => new Promise<void>(() => {}), // never resolves, never rejects
  };
}

/** A sentinel used to detect "did not resolve within the deadline" without ever actually hanging the
 *  test process — `Promise.race` settles on whichever promise finishes first; the losing promise is
 *  simply left to float (no timer/socket keeps the event loop alive, so it does not block process exit). */
const TIMEOUT = Symbol("timeout");
async function raceAgainstTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  return Promise.race([p, new Promise<typeof TIMEOUT>((resolve) => setTimeout(() => resolve(TIMEOUT), ms))]);
}

describe("POST /chat — memory write is async fire-and-forget (T6)", () => {
  it("a memory write that never resolves must NOT hang the shopper's reply — /chat still returns 200 well within a short deadline, and memoryActive is IDENTICAL to a normal (non-hung) turn with the same signals", async () => {
    process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
    process.env.WIDGET_AUTH_REQUIRED = "true";
    process.env.GUEST_TOKEN_SECRET = GUEST_SECRET;
    // The /chat memory SUBJECT comes ONLY from a verified `x-guest-token` (ADR-0019 task 4/9,
    // server.ts:2159-2161 `guestAnonIdFrom` -> `memorySubjectId`) — a bare `signals.anonId` is never
    // honored there, so both requests must present one for `memorySubject` (and therefore
    // `memoryActive`) to resolve at all.
    const payloadFor = (sessionId: string) => ({
      sessionId,
      message: "I like fragrance-free stuff",
      signals: { cart: "empty" },
      widgetToken: DEMO_WIDGET_TOKEN,
    });
    const headers = () => guestTokenHeader(GUEST_SECRET, "demo", VALID_ANON_ID);

    // Control: the SAME signals/consent inputs, but a normal (resolving) vector port — establishes the
    // golden `memoryActive` value independent of any guess about this deployment's consent defaults.
    // `memoryActive` is derived from consent (decideMemoryWrite) BEFORE remember() is ever called
    // (server.ts ~2356-2357), so it must be identical in both requests regardless of what the write does.
    const controlStore = new InMemoryRuntimeStore();
    const controlApp = await buildServer({
      store: controlStore,
      vectorPort: createInMemoryVectorStore(),
      modelPort: distillingModel([{ text: "prefers fragrance-free products" }]),
      memoryEnabled: true,
    });
    const control = await controlApp.inject({ method: "POST", url: "/chat", headers: headers(), payload: payloadFor("async-write-control") });
    expect(control.statusCode).toBe(200);
    const goldenMemoryActive = control.json().memoryActive;
    expect(goldenMemoryActive).toBeDefined();
    await controlApp.close();

    // The actual case under test: an identical turn, but the vector port's `upsert` never resolves.
    const store = new InMemoryRuntimeStore();
    const vector = vectorPortWithHungUpsert();
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });
    const injected = app.inject({ method: "POST", url: "/chat", headers: headers(), payload: payloadFor("async-write-1") });

    // Generous relative to a real request's latency, but far short of vitest's default per-test timeout
    // — if remember() genuinely blocks the reply (today), this races out to TIMEOUT and the assertion
    // below fails with a clear, deterministic reason rather than a real multi-second hang.
    const result = await raceAgainstTimeout(injected, 500);
    expect(result).not.toBe(TIMEOUT);
    if (result === TIMEOUT) return; // unreachable after the assertion above; narrows the type for TS

    expect(result.statusCode).toBe(200);
    expect(result.json().memoryActive).toEqual(goldenMemoryActive);
    // Deliberately no `app.close()` here: the injected request's internal work (the hung `upsert` call)
    // is still pending by design. A bare, unresolved Promise holds no timer/socket, so it cannot keep the
    // process alive on its own — but calling `close()` while a route handler may still be "in flight"
    // (however that flight ends, once this PR's fire-and-forget change lands) is an unnecessary risk this
    // test doesn't need to take to prove its point.
  });

  it("companion pin (already green — NOT part of this PR's red set): a kill-armed turn still triggers NO memory write at all, fire-and-forget or not", async () => {
    process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
    process.env.WIDGET_AUTH_REQUIRED = "true";
    process.env.GUEST_TOKEN_SECRET = GUEST_SECRET;
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    await armKill(store, "global", "operator-halt");

    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      // A resolvable memory subject (guest token), so "no write" below is a genuine kill-switch proof —
      // not trivially true merely because no subject resolved at all.
      headers: guestTokenHeader(GUEST_SECRET, "demo", VALID_ANON_ID),
      payload: {
        sessionId: "async-write-killed-1",
        message: "I like fragrance-free stuff",
        signals: { cart: "empty" },
        widgetToken: DEMO_WIDGET_TOKEN,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().flags).toContain("kill_switch");
    const log = await store.readAudit({ tenantId: "demo" });
    expect(log.map((r) => r.action)).not.toContain("write.ordinary");
    expect(log.map((r) => r.action)).not.toContain("write.special");
    await app.close();
  });
});
