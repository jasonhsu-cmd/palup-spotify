import { describe, it, expect, afterEach } from "vitest";
import { InMemoryRuntimeStore, createInMemoryVectorStore, mintWidgetToken } from "@palup/platform-ports";
import type { ModelPort, ModelRequest, VectorPort } from "@palup/platform-ports";
import { armKill } from "@palup/state-postgres";
import { buildServer } from "../src/server.js";
import { guestTokenHeader } from "./helpers/guest-token.js";

// semantic-memory-v1, PR2 (write path), T6 — REVERTED (live-staging finding, 2026-08-18). T6 made the
// /chat write path fire-and-forget (`void memoryService.remember(...).catch(...)`) on the theory that the
// write is off the shopper's critical path. Live diagnosis on staging proved the opposite: Cloud Run
// throttles a container's CPU to ~0 once the HTTP response has been sent, so a write kicked off AFTER the
// reply never actually runs — confirmed by 0 facts ever landing in `vp_ann` and by metering showing only
// ONE `shopper`-tagged model call per turn (the reply) instead of two (reply + distiller). server.ts now
// `await`s `remember()` INSIDE the existing try/catch, so the write runs DURING the request, where Cloud
// Run guarantees CPU. This file's ORIGINAL acceptance criterion ("the reply returns before the write
// resolves") is exactly the property that caused the staging outage, so it is retired here, not merely
// updated: this file now pins the opposite, corrected contract —
//   1. the write is now genuinely synchronous (awaited), so it has a real chance to complete before the
//      Cloud Run container's CPU is throttled post-response; and
//   2. fail-open is preserved: a `remember()` that THROWS is still caught and logged, and never turns into
//      a broken/non-200 reply to the shopper.
//
// `vectorPort.upsert` throwing is how we simulate "the memory write failed" — buildServer has no
// `distiller`/`memoryService` injection seam (only `store` / `modelPort` / `vectorPort`), so the most
// faithful, least-invasive way to make `remember()` fail is to make the ONE vector-port op `remember()`
// calls to persist (`deps.vector.upsert`, service.ts:702/716) reject — `query`/`list`/`deleteById`/
// `deleteNamespace` are left fully functional so nothing else on this path (e.g. the opportunistic
// `sweepExpired`, still fire-and-forget via `void ...catch()`) is perturbed.

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

/** Wraps a real in-memory VectorPort but replaces `upsert` with one that always REJECTS — the narrowest
 *  possible simulation of "the write failed", isolated to exactly the op `remember()` persists through. */
function vectorPortWithFailingUpsert(): VectorPort {
  const real = createInMemoryVectorStore();
  return {
    ...real,
    upsert: () => Promise.reject(new Error("simulated vector-store failure")),
  };
}

describe("POST /chat — memory write is synchronous (T6 reverted)", () => {
  it("a memory write that throws is caught and does NOT break the shopper's reply — /chat still returns 200, and memoryActive is IDENTICAL to a normal (non-failing) turn with the same signals", async () => {
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
    const control = await controlApp.inject({ method: "POST", url: "/chat", headers: headers(), payload: payloadFor("sync-write-control") });
    expect(control.statusCode).toBe(200);
    const goldenMemoryActive = control.json().memoryActive;
    expect(goldenMemoryActive).toBeDefined();
    await controlApp.close();

    // The actual case under test: an identical turn, but the vector port's `upsert` always rejects.
    const store = new InMemoryRuntimeStore();
    const vector = vectorPortWithFailingUpsert();
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });
    const result = await app.inject({ method: "POST", url: "/chat", headers: headers(), payload: payloadFor("sync-write-1") });

    // Fail-open: the write is now awaited INSIDE the request, so a rejecting `remember()` is caught right
    // there (server.ts's try/catch around the `await`) — it must never surface as a broken/non-200 reply.
    expect(result.statusCode).toBe(200);
    expect(result.json().memoryActive).toEqual(goldenMemoryActive);
    await app.close();
  });

  it("companion pin (unchanged by this fix): a kill-armed turn still triggers NO memory write at all", async () => {
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
        sessionId: "sync-write-killed-1",
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
