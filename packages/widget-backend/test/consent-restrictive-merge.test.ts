import { describe, it, expect, vi, afterEach } from "vitest";
import { armKill } from "@palup/state-postgres";
import { InMemoryRuntimeStore, createInMemoryVectorStore, mintWidgetToken, mintShopperToken } from "@palup/platform-ports";
import type { ModelPort, ModelRequest } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";

// BLOCK-1 (security-review remediation, PR #152) — sign-in must never silently VOID an explicit
// opt-out. Subject-scoped auth (identity.ts `memorySubjectId`) rebinds the memory subject from the raw
// guest anonId to `acct:<shopperId>` once a shopper is server-verified. Without a restrictive merge, a
// consent record the shopper recorded as a GUEST ("out") simply stops resolving once they sign in — the
// lookup keys off `acct:<shopperId>` (a brand-new KV row, never written) and degrades to the fail-closed
// DEFAULT, which the US opt-out regime (`consent1 !== "out"`) reads as ALLOWED. `decideMemoryWrite`'s own
// logic is unchanged; only ITS INPUT regressed with the subject-derivation change.
//
// Proven by execution (both independent reviews): guest records memoryOrdinary:"out" -> chats as guest
// -> 0 facts written. Same person signs in with a verified shopper token -> 1 ordinary fact written under
// `acct:<shopperId>`. This test reproduces exactly that scenario and must show 0 facts written post-fix.

const WIDGET_SECRET = "wsecret";
const SHOPPER_SECRET = "shopper-secret";
const DEMO_WIDGET_TOKEN = mintWidgetToken(WIDGET_SECRET, "demo", 3_600);
const SHOPPER_ID = "shopify:demo:48291";
const GUEST_ANON_ID = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // base32, passes validateAnonId

const ENV_KEYS = ["WIDGET_TOKEN_SECRET", "WIDGET_AUTH_REQUIRED", "SHOPPER_AUTH", "SHOPPER_TOKEN_SECRET", "MERCHANT_REGION"];
afterEach(() => ENV_KEYS.forEach((k) => delete process.env[k]));

function armAuth(): void {
  process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
  process.env.WIDGET_AUTH_REQUIRED = "true";
  process.env.SHOPPER_AUTH = "true";
  process.env.SHOPPER_TOKEN_SECRET = SHOPPER_SECRET;
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

describe("BLOCK-1 — restrictive-merge consent across guest/account subjects on sign-in", () => {
  it("THE REVIEWER'S SCENARIO: guest opts OUT, then signs in — the opt-out survives, no ordinary fact is written under acct:<shopperId>", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    // 1. As a GUEST (no x-shopper-token), explicitly opt OUT of ordinary memory.
    const consentRes = await app.inject({
      method: "POST",
      url: "/consent",
      payload: { anonId: GUEST_ANON_ID, memoryOrdinary: "out", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(consentRes.statusCode).toBe(200);

    // 2. Still as a guest: chats -> nothing is written (sanity — this half already worked pre-fix).
    const guestChat = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "guest-1", message: "I like fragrance-free stuff", signals: { anonId: GUEST_ANON_ID }, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(guestChat.statusCode).toBe(200);
    expect(upsertSpy).not.toHaveBeenCalled();

    // 3. THE SAME PERSON signs in with a verified shopper token — their browser still legitimately holds
    // the old guest anonId, which the widget continues to send.
    const signedInChat = await app.inject({
      method: "POST",
      url: "/chat",
      headers: { "x-shopper-token": shopperToken() },
      payload: {
        sessionId: "signed-in-1",
        message: "I like fragrance-free stuff",
        signals: { anonId: GUEST_ANON_ID },
        widgetToken: DEMO_WIDGET_TOKEN,
      },
    });
    expect(signedInChat.statusCode).toBe(200);

    // THE ASSERTION THAT WAS FAILING: sign-in must not silently void the guest's recorded opt-out.
    expect(upsertSpy).not.toHaveBeenCalled();
    const log = await store.readAudit({ tenantId: "demo" });
    expect(log.map((r) => r.action)).not.toContain("write.ordinary");
  });

  it("a guest 'in' is NEVER adopted for the account — outside the US it stays denied (borrowed opt-in is not honored)", async () => {
    armAuth();
    process.env.MERCHANT_REGION = "eu";
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    await app.inject({
      method: "POST",
      url: "/consent",
      payload: { anonId: GUEST_ANON_ID, memoryOrdinary: "in", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });

    const res = await app.inject({
      method: "POST",
      url: "/chat",
      headers: { "x-shopper-token": shopperToken() },
      payload: { sessionId: "borrow-in-1", message: "I like fragrance-free stuff", signals: { anonId: GUEST_ANON_ID }, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    // The account has no consent record of its own; a guest "in" must not be borrowed for it.
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("the account's OWN 'in' still allows the write (an explicit account-level grant is honored)", async () => {
    armAuth();
    process.env.MERCHANT_REGION = "eu";
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    // The shopper records consent WHILE signed in — directly against the account subject.
    await app.inject({
      method: "POST",
      url: "/consent",
      headers: { "x-shopper-token": shopperToken() },
      payload: { memoryOrdinary: "in", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });

    const res = await app.inject({
      method: "POST",
      url: "/chat",
      headers: { "x-shopper-token": shopperToken() },
      payload: { sessionId: "account-in-1", message: "I like fragrance-free stuff", signals: {}, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(upsertSpy).toHaveBeenCalled();
  });

  it("no anonId EVER supplied on a signed-in turn, and no guest merge was ever attempted -> the (empty) account record alone governs", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    // A guest record with an "out" exists under GUEST_ANON_ID, but no signed-in turn EVER supplies that
    // (or any) anonId, so the merge+write-through (N2) never runs — there is nothing to durabilize, and
    // this is orthogonal to it: the account has no record of its own, so its own "unknown" default
    // governs under the US opt-out regime (unrelated to the guest's "out", which is simply never consulted).
    await app.inject({
      method: "POST",
      url: "/consent",
      payload: { anonId: GUEST_ANON_ID, memoryOrdinary: "out", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });

    const res = await app.inject({
      method: "POST",
      url: "/chat",
      headers: { "x-shopper-token": shopperToken() },
      payload: { sessionId: "no-anonid-1", message: "I like fragrance-free stuff", signals: {}, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(upsertSpy).toHaveBeenCalled();
  });

  // N2 (HIGH, security review round 3) — the merge above is READ-TIME ONLY: it corrects the turn it runs
  // on but writes nothing back, so the opt-out survived only as long as the client kept echoing the
  // EXACT guest anonId that recorded it. Proven by execution: 0 writes with the echoed id, 1 write once
  // it's gone (new device, cleared storage, or the widget's own forgetMe(), which mints a fresh anonId).
  // This REPLACES the prior version of this test, which asserted that later write as CORRECT — it
  // was the void this fix closes, not a feature.
  it("N2 — a guest opt-out, once merged on a signed-in turn, becomes DURABLE: a LATER signed-in turn with NO guest anonId at all still yields zero writes", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    // 1. As a GUEST, explicitly opt OUT of ordinary memory.
    await app.inject({
      method: "POST",
      url: "/consent",
      payload: { anonId: GUEST_ANON_ID, memoryOrdinary: "out", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });

    // 2. Signs in and this turn STILL echoes the old guest anonId (the browser legitimately still holds
    //    it) — this is the turn where the merge discovers the guest "out" and (N2) durably writes it
    //    through to the account record. The write is refused THIS turn too (sanity, already proven by
    //    BLOCK-1's own test above).
    const echoedTurn = await app.inject({
      method: "POST",
      url: "/chat",
      headers: { "x-shopper-token": shopperToken() },
      payload: { sessionId: "durable-1a", message: "I like fragrance-free stuff", signals: { anonId: GUEST_ANON_ID }, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(echoedTurn.statusCode).toBe(200);
    expect(upsertSpy).not.toHaveBeenCalled();

    // 3. THE DURABILITY CHECK: a LATER turn — fresh browser / cleared storage / post-forgetMe() — that
    //    supplies NO anonId at all (so the read-time merge cannot run: there is no guest record to
    //    consult). Pre-fix this fell back to the account's own never-written "unknown" default, which the
    //    US opt-out regime reads as ALLOWED (1 write). Post-fix the account record itself durably says
    //    "out" (written in step 2), so the write is STILL refused.
    const laterTurn = await app.inject({
      method: "POST",
      url: "/chat",
      headers: { "x-shopper-token": shopperToken() },
      payload: { sessionId: "durable-1b", message: "I like fragrance-free stuff", signals: {}, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(laterTurn.statusCode).toBe(200);
    expect(upsertSpy).not.toHaveBeenCalled();

    // The durable write-through itself is audited (consent.record), not just the (still-silent) refused
    // fact write — an operator can see the account's consent state actually changed.
    const log = await store.readAudit({ tenantId: "demo" });
    expect(log.map((r) => r.action)).toContain("consent.record");
  });

  // Finding 2 (security review, round 3): the write-through is a SERVER-derived consent change. In the
  // immutable log it was byte-indistinguishable from an explicit shopper `POST /consent` — same actor
  // ("shopper"), same reversalPath — so an operator could not tell a decision the shopper MADE from one
  // the system INFERRED, and the recorded reversal path was provably FALSE for the merged case (a later
  // /consent "in" is re-asserted back to "out" on the next turn that still presents the guest id).
  it("Finding 2 — the write-through's audit entry is distinguishable from a shopper-initiated /consent, with a reversal path that is actually true", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    // The shopper's OWN explicit choice, as a guest.
    await app.inject({
      method: "POST",
      url: "/consent",
      payload: { anonId: GUEST_ANON_ID, memoryOrdinary: "out", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });
    // Signing in triggers the SERVER-derived write-through onto the account subject.
    await app.inject({
      method: "POST",
      url: "/chat",
      headers: { "x-shopper-token": shopperToken() },
      payload: { sessionId: "audit-fidelity-1", message: "I like fragrance-free stuff", signals: { anonId: GUEST_ANON_ID }, widgetToken: DEMO_WIDGET_TOKEN },
    });

    const entries = (await store.readAudit({ tenantId: "demo" })).filter((r) => r.action === "consent.record");
    expect(entries).toHaveLength(2);
    const shopperEntry = entries.find((r) => (r.input as { source?: string }).source === "shopper");
    const mergeEntry = entries.find((r) => (r.input as { source?: string }).source === "guest-merge");

    // The two are genuinely distinguishable — that is the whole point.
    expect(shopperEntry).toBeDefined();
    expect(mergeEntry).toBeDefined();
    expect(shopperEntry!.actor).toBe("shopper");
    expect(mergeEntry!.actor).toBe("agent:shopper-memory"); // the server's merge, not the shopper
    // ...and the merged entry does NOT carry the shopper-facing reversal path, which is false for it.
    expect(mergeEntry!.reversalPath).not.toBe(shopperEntry!.reversalPath);
    // Assert the PROPERTY (both required steps are named), not the exact prose — an earlier version of
    // this test pinned wording that was itself still inaccurate. Security review proved by execution that
    // NEITHER step alone reverses this entry: /consent alone is re-asserted on the next turn, and dropping
    // the guest anonId alone leaves the account row "out" forever.
    expect(mergeEntry!.reversalPath).toMatch(/BOTH/);
    expect(mergeEntry!.reversalPath).toMatch(/POST \/consent/);
    expect(mergeEntry!.reversalPath).toMatch(/guest anonId/);
    expect(mergeEntry!.reversalPath).toMatch(/[Ee]ither step alone/);
    await app.close();
  });

  // NN#4 regression lock (governance review, round 3): the write-through is a NEW autonomous WRITE on the
  // /chat path, so the operator kill switch must halt it like every other autonomous action. Correct by
  // reading (`!kill` guards the block) but nothing locked it — /forget has such a test, this did not.
  it("NN#4 — an operator kill switch halts the consent write-through: nothing is persisted to the account record", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    // A guest opt-out exists, so a NON-halted turn would durably write it through to the account.
    await app.inject({
      method: "POST",
      url: "/consent",
      payload: { anonId: GUEST_ANON_ID, memoryOrdinary: "out", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });
    await armKill(store, "global", "operator-halt");

    const res = await app.inject({
      method: "POST",
      url: "/chat",
      headers: { "x-shopper-token": shopperToken() },
      payload: { sessionId: "kill-wt-1", message: "I like fragrance-free stuff", signals: { anonId: GUEST_ANON_ID }, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().flags).toContain("kill_switch"); // the turn really was halted

    // No consent.record audit from the write-through (the /consent grant above is a DIFFERENT subject —
    // the guest — so assert specifically that the ACCOUNT subject was never written).
    const log = await store.readAudit({ tenantId: "demo" });
    const writeThroughs = log.filter((r) => r.action === "consent.record");
    expect(writeThroughs).toHaveLength(1); // only the shopper's own original guest grant
    await app.close();
  });

  it("N2 — a guest 'in' is still NEVER durably adopted either: after the same borrowed-'in' turn, a LATER anonId-less turn behaves exactly as before (still denied)", async () => {
    armAuth();
    process.env.MERCHANT_REGION = "eu";
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    await app.inject({
      method: "POST",
      url: "/consent",
      payload: { anonId: GUEST_ANON_ID, memoryOrdinary: "in", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });

    // Signed-in turn that echoes the guest anonId — the merge sees guest "in" but (by design) never
    // adopts it, so there is no diff against the account's own "unknown" and N2's write-through never
    // fires (no consent.record audit for the account subject at all).
    await app.inject({
      method: "POST",
      url: "/chat",
      headers: { "x-shopper-token": shopperToken() },
      payload: { sessionId: "borrow-in-durable-1", message: "I like fragrance-free stuff", signals: { anonId: GUEST_ANON_ID }, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(upsertSpy).not.toHaveBeenCalled();

    // A LATER turn with no anonId at all behaves identically — nothing was durably written, so this is
    // not "still denied because it's now durable out", it is "still denied because there was never
    // anything to grant in the first place" (EU fail-closed default).
    const later = await app.inject({
      method: "POST",
      url: "/chat",
      headers: { "x-shopper-token": shopperToken() },
      payload: { sessionId: "borrow-in-durable-2", message: "I like fragrance-free stuff", signals: {}, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(later.statusCode).toBe(200);
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  // C7 (docs/MEMORY-GO-LIVE-CHECKLIST.md) restated accurately for N2: this is a documented, ACCEPTED
  // residual, not a regression introduced carelessly — the task explicitly requires writing through ONLY
  // the restrictive ("out") direction, and "out always wins outright" (mergeConsentTier) is what makes a
  // guest opt-out durable in the first place. The cost of that same rule is that it can ALSO durably
  // override a later authenticated opt-in for as long as a stale guest "out" record lingers and the
  // client keeps presenting it. This test exists to make that cost visible and regression-locked, not to
  // assert it is desirable.
  it("C7 (restated) — a stale guest 'out' can durably override a LATER authenticated /consent 'in', for as long as the client still presents that guest anonId (accepted residual, not fixed here)", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    // 1. Guest opts OUT.
    await app.inject({
      method: "POST",
      url: "/consent",
      payload: { anonId: GUEST_ANON_ID, memoryOrdinary: "out", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });

    // 2. Signs in, echoes the guest anonId once -> N2 durably writes "out" to the account.
    await app.inject({
      method: "POST",
      url: "/chat",
      headers: { "x-shopper-token": shopperToken() },
      payload: { sessionId: "c7-1", message: "I like fragrance-free stuff", signals: { anonId: GUEST_ANON_ID }, widgetToken: DEMO_WIDGET_TOKEN },
    });

    // 3. The SAME shopper then explicitly, authentically opts back IN via /consent while signed in.
    const optInRes = await app.inject({
      method: "POST",
      url: "/consent",
      headers: { "x-shopper-token": shopperToken() },
      payload: { memoryOrdinary: "in", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(optInRes.statusCode).toBe(200);

    // 4. A later chat turn that STILL echoes the (now-stale) guest anonId: the merge re-resolves "out"
    // (guest "out" wins outright over the account's fresh "in") and N2 re-durabilizes it — the shopper's
    // explicit opt-in is overridden again, this time durably.
    const overriddenTurn = await app.inject({
      method: "POST",
      url: "/chat",
      headers: { "x-shopper-token": shopperToken() },
      payload: { sessionId: "c7-2", message: "I like fragrance-free stuff", signals: { anonId: GUEST_ANON_ID }, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(overriddenTurn.statusCode).toBe(200);
    expect(upsertSpy).not.toHaveBeenCalled();

    // 5. Unlike pre-N2 (where omitting the anonId would have let the account's fresh "in" govern again),
    // the override is now DURABLE: even a turn presenting NO guest anonId at all still comes back denied.
    const noAnonIdTurn = await app.inject({
      method: "POST",
      url: "/chat",
      headers: { "x-shopper-token": shopperToken() },
      payload: { sessionId: "c7-3", message: "I like fragrance-free stuff", signals: {}, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(noAnonIdTurn.statusCode).toBe(200);
    expect(upsertSpy).not.toHaveBeenCalled();
  });
});
