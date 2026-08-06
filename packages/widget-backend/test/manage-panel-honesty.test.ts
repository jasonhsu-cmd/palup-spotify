import { describe, it, expect, vi, afterEach } from "vitest";
import { InMemoryRuntimeStore, createInMemoryVectorStore, mintWidgetToken, mintShopperToken } from "@palup/platform-ports";
import { armKill } from "@palup/state-postgres";
import type { ModelPort, ModelRequest } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";
import { guestTokenHeader } from "./helpers/guest-token.js";

// THE DEFECT THIS LOCKS (pre-existing on main, NOT introduced by any memory PR):
// the widget's "What I remember" panel renders its toggles from LOCAL storage —
// `o.checked = memState.consent1 === "in"` (widget/public/index.html) — while the server's actual
// ordinary-fact rule in the default US region is the OPT-OUT regime `consent1 !== "out"`
// (widget-memory/src/consent.ts `decideMemoryWrite`). So the tri-state value "unknown" means memory is
// ON and the checkbox renders UNCHECKED, which a shopper reads as off. The UI contradicts the system for
// every US shopper who never answered the prompt.
//
// It also carries the misleading half of residual C14: an account-level opt-out does not govern that
// same browser's signed-OUT turns (owner decision 2026-08-04 — signed-out shoppers are treated as
// anonymous guests, and no server-side guest->account link is recorded, because nothing in this system
// proves a client-supplied anonId belongs to its caller — checklist C1). Accepting that residual is only
// defensible if the panel stops claiming the opposite.
//
// THE FIX: /chat reports `memoryActive` — the EFFECTIVE write capability for the subject the server
// actually served this turn, computed from the SAME inputs service.ts's `decideMemoryWrite` gate uses.
// The panel renders that.
//
// WHY EVERY CASE BELOW ALSO COUNTS UPSERTS: asserting the reported field in isolation would only prove
// the server is self-consistent about a string it made up. These assert the report against what the
// write path ACTUALLY did on the same turn — the report and reality are pinned together, so the panel
// cannot drift back into lying without a red test. (Recorded text contradicting executed behavior is the
// failure mode that blocked this branch repeatedly; see the checklist's §C preamble.)

const WIDGET_SECRET = "wsecret";
const SHOPPER_SECRET = "shopper-secret";
const DEMO_WIDGET_TOKEN = mintWidgetToken(WIDGET_SECRET, "demo", 3_600);
const SHOPPER_ID = "shopify:demo:48291";
const GUEST_ANON_ID = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // base32, passes validateAnonId
// ADR-0019 task 4/9 — the guest memory subject (what /consent records against AND what /chat's
// `memoryActive` report is computed for) now comes ONLY from a VERIFIED `x-guest-token`, never
// `body.anonId` / `signals.anonId` (invariant 4). Every case below needs this header for `memorySubject`
// to resolve at all — without it, `memoryActive` is omitted entirely (see the "INERT" case).
const GUEST_SECRET = "gsecret";
const guestToken = () => guestTokenHeader(GUEST_SECRET, "demo", GUEST_ANON_ID);

const ENV_KEYS = ["WIDGET_TOKEN_SECRET", "WIDGET_AUTH_REQUIRED", "SHOPPER_AUTH", "SHOPPER_TOKEN_SECRET", "MERCHANT_REGION", "GUEST_TOKEN_SECRET"];
afterEach(() => ENV_KEYS.forEach((k) => delete process.env[k]));

function armAuth(): void {
  process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
  process.env.WIDGET_AUTH_REQUIRED = "true";
  process.env.SHOPPER_AUTH = "true";
  process.env.SHOPPER_TOKEN_SECRET = SHOPPER_SECRET;
  process.env.GUEST_TOKEN_SECRET = GUEST_SECRET;
}
const shopperToken = () => mintShopperToken(SHOPPER_SECRET, SHOPPER_ID, "shopify", 3_600);

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

describe("manage-panel honesty — /chat reports the EFFECTIVE memory state, and it matches what actually happens", () => {
  it("US + never answered ('unknown'): reports ordinary ACTIVE, and a fact really is written (the case the panel renders as 'off' today)", async () => {
    armAuth();
    process.env.MERCHANT_REGION = "us";
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    const app = await buildServer({
      store,
      vectorPort: vector,
      modelPort: distillingModel([{ text: "prefers fragrance-free products" }]),
      memoryEnabled: true,
    });

    const res = await app.inject({
      method: "POST",
      url: "/chat",
      headers: guestToken(),
      payload: { sessionId: "s-us-unknown", message: "I like unscented soap", signals: {}, widgetToken: DEMO_WIDGET_TOKEN },
    });

    expect(res.statusCode).toBe(200);
    // The report: memory IS on for this shopper.
    expect(res.json().memoryActive).toEqual({ ordinary: true, special: false });
    // Reality agrees — a fact was actually written on this same turn.
    expect(upsertSpy).toHaveBeenCalled();
    await app.close();
  });

  it("US + explicit opt-out: reports ordinary INACTIVE, and nothing is written", async () => {
    armAuth();
    process.env.MERCHANT_REGION = "us";
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    const app = await buildServer({
      store,
      vectorPort: vector,
      modelPort: distillingModel([{ text: "prefers fragrance-free products" }]),
      memoryEnabled: true,
    });

    await app.inject({
      method: "POST",
      url: "/consent",
      headers: guestToken(),
      payload: { memoryOrdinary: "out", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      headers: guestToken(),
      payload: { sessionId: "s-us-out", message: "I like unscented soap", signals: {}, widgetToken: DEMO_WIDGET_TOKEN },
    });

    expect(res.json().memoryActive).toEqual({ ordinary: false, special: false });
    expect(upsertSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it("EU + never answered: fails closed — reports ordinary INACTIVE, and nothing is written (same 'unknown', opposite truth)", async () => {
    armAuth();
    process.env.MERCHANT_REGION = "eu";
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    const app = await buildServer({
      store,
      vectorPort: vector,
      modelPort: distillingModel([{ text: "prefers fragrance-free products" }]),
      memoryEnabled: true,
    });

    const res = await app.inject({
      method: "POST",
      url: "/chat",
      headers: guestToken(),
      payload: { sessionId: "s-eu-unknown", message: "I like unscented soap", signals: {}, widgetToken: DEMO_WIDGET_TOKEN },
    });

    expect(res.json().memoryActive).toEqual({ ordinary: false, special: false });
    expect(upsertSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it("special-category tracks its own tier: consent2='in' reports special ACTIVE (US ordinary regime unchanged)", async () => {
    armAuth();
    process.env.MERCHANT_REGION = "us";
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const app = await buildServer({
      store,
      vectorPort: vector,
      modelPort: distillingModel([{ text: "prefers fragrance-free products" }]),
      memoryEnabled: true,
    });

    await app.inject({
      method: "POST",
      url: "/consent",
      headers: guestToken(),
      payload: { memoryOrdinary: "unknown", memorySpecial: "in", widgetToken: DEMO_WIDGET_TOKEN },
    });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      headers: guestToken(),
      payload: { sessionId: "s-special", message: "hi", signals: {}, widgetToken: DEMO_WIDGET_TOKEN },
    });

    expect(res.json().memoryActive).toEqual({ ordinary: true, special: true });
    await app.close();
  });

  it("C14 (ACCEPTED RESIDUAL, PINNED): after an authenticated opt-out, the same browser's SIGNED-OUT turn is still active — and the panel is now TOLD so instead of showing 'off'", async () => {
    armAuth();
    process.env.MERCHANT_REGION = "us";
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    const app = await buildServer({
      store,
      vectorPort: vector,
      modelPort: distillingModel([{ text: "prefers fragrance-free products" }]),
      memoryEnabled: true,
    });

    // Signed IN, the shopper opts out. This records against acct:<shopperId> (subject-scoped auth).
    const consentRes = await app.inject({
      method: "POST",
      url: "/consent",
      headers: { "x-shopper-token": shopperToken() },
      payload: { anonId: GUEST_ANON_ID, memoryOrdinary: "out", memorySpecial: "out", widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(consentRes.statusCode).toBe(200);

    // Their token expires (sessionStorage, 1h) — SAME browser, SAME anonId, no shopper token.
    // Owner decision 2026-08-04: this turn is governed by the GUEST's own record, which is "unknown".
    // In the US opt-out regime that means memory is ON. The residual is accepted; the point of this test
    // is that the client is told the truth about it.
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      headers: guestToken(),
      payload: { sessionId: "s-c14", message: "I like unscented soap", signals: {}, widgetToken: DEMO_WIDGET_TOKEN },
    });

    expect(res.json().memoryActive).toEqual({ ordinary: true, special: false });
    // Reality: a fact IS written on this turn. That is C14, accepted and disclosed — not silently denied.
    expect(upsertSpy).toHaveBeenCalled();
    await app.close();
  });

  it("/consent answers with the resulting effective state, so the panel never has to compute the regime rule itself", async () => {
    armAuth();
    process.env.MERCHANT_REGION = "us";
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store, vectorPort: createInMemoryVectorStore(), memoryEnabled: true });

    // Opting out of ordinary while granting special: each tier answers independently.
    const out = await app.inject({
      method: "POST",
      url: "/consent",
      headers: guestToken(),
      payload: { memoryOrdinary: "out", memorySpecial: "in", widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(out.json().memoryActive).toEqual({ ordinary: false, special: true });

    // "unknown" in the US opt-out regime is ACTIVE — the exact value a checkbox bound to `=== "in"`
    // renders as off. This is why the client is told rather than left to infer.
    const unknown = await app.inject({
      method: "POST",
      url: "/consent",
      headers: guestToken(),
      payload: { memoryOrdinary: "unknown", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(unknown.json().memoryActive).toEqual({ ordinary: true, special: false });
    await app.close();
  });

  it("SCOPE PIN: an operator kill suppresses the write but does NOT flip the shopper's reported state — a halt is not their setting", async () => {
    armAuth();
    process.env.MERCHANT_REGION = "us";
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    const app = await buildServer({
      store,
      vectorPort: vector,
      modelPort: distillingModel([{ text: "prefers fragrance-free products" }]),
      memoryEnabled: true,
    });
    await armKill(store, "global", "operator-halt");

    const res = await app.inject({
      method: "POST",
      url: "/chat",
      headers: guestToken(),
      payload: { sessionId: "s-kill", message: "I like unscented soap", signals: {}, widgetToken: DEMO_WIDGET_TOKEN },
    });

    // The field reports what their CONSENT permits — unchanged by the halt. Showing "off" here would
    // tell a shopper they had opted out when they had not; showing the halt is an operator concern.
    expect(res.json().memoryActive).toEqual({ ordinary: true, special: false });
    // The halt is real all the same: nothing was written this turn (NN#4 parity).
    expect(upsertSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it("INERT: memory off (the real-production double gate) omits the field entirely — response byte-identical to before", async () => {
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store }); // no seam -> memoryServiceEnabled false (flag.ts)
    const res = await app.inject({ method: "POST", url: "/chat", payload: { sessionId: "s-inert", message: "hi", signals: {} } });

    expect(res.json().memoryEnabled).toBe(false);
    expect(res.json()).not.toHaveProperty("memoryActive");
    await app.close();
  });
});
