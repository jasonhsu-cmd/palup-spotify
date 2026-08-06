import { describe, it, expect, afterEach, vi } from "vitest";
import {
  InMemoryRuntimeStore,
  createInMemoryVectorStore,
  mintWidgetToken,
  mintShopperToken,
} from "@palup/platform-ports";
import { lookupConsent } from "@palup/state-postgres";
import { subjectNamespace, accountSubjectId } from "@palup/widget-memory";
import type { ModelPort, ModelRequest } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";
import { guestTokenHeader } from "./helpers/guest-token.js";

// SUBJECT-SCOPED AUTH — the memory subject is now derived from the SERVER-VERIFIED shopper principal
// (`acct:<shopperId>`), not from a client-supplied `anonId`.
//
// The hole this closes: `validateAnonId` proves a string is well-FORMED, never that the caller owns it,
// and widget auth binds only the TENANT. So within one tenant, possession of another shopper's `anonId`
// was enough to record THEIR consent and — via the destructive /forget — DELETE their memory. Two prior
// security reviews recorded that as go-live residuals C1/C2.
//
// The tests that matter here are the two "attacker" cases: an authenticated shopper who supplies a
// VICTIM's anonId must not touch the victim's subject at all.

const WIDGET_SECRET = "wsecret";
const SHOPPER_SECRET = "shopper-secret";
const DEMO_WIDGET_TOKEN = mintWidgetToken(WIDGET_SECRET, "demo", 3_600);
// shopperIdTenant() parses `<source>:<tenant>:<rest>` — the tenant segment must equal the widget
// token's tenant or the cross-shop check rejects the token.
const ATTACKER_SHOPPER_ID = "shopify:demo:attacker-1";
const VICTIM_ANON_ID = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // a well-formed anonId the attacker "obtained"
// ADR-0019 task 4/9 — the guest memory subject now comes ONLY from a VERIFIED `x-guest-token`, never a
// bare client-typed `anonId` (invariant 4). See the per-test comments below for how each case's INTENT
// is preserved under this shift.
const GUEST_SECRET = "gsecret";

const ENV_KEYS = ["WIDGET_TOKEN_SECRET", "WIDGET_AUTH_REQUIRED", "SHOPPER_AUTH", "SHOPPER_TOKEN_SECRET", "GUEST_TOKEN_SECRET"];
afterEach(() => ENV_KEYS.forEach((k) => delete process.env[k]));

function armAuth(): void {
  process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
  process.env.WIDGET_AUTH_REQUIRED = "true";
  process.env.SHOPPER_AUTH = "true";
  process.env.SHOPPER_TOKEN_SECRET = SHOPPER_SECRET;
  process.env.GUEST_TOKEN_SECRET = GUEST_SECRET;
}
const attackerToken = () => mintShopperToken(SHOPPER_SECRET, ATTACKER_SHOPPER_ID, "shopify", 3_600);

describe("subject-scoped auth — a verified shopper keys off acct:<shopperId>, not a client anonId", () => {
  it("POST /consent records under the ACCOUNT subject and leaves the supplied anonId's record untouched", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store, vectorPort: createInMemoryVectorStore() });

    const res = await app.inject({
      method: "POST",
      url: "/consent",
      headers: { "x-shopper-token": attackerToken() },
      payload: {
        anonId: VICTIM_ANON_ID, // ignored: a verified principal wins
        memoryOrdinary: "in",
        memorySpecial: "in",
        widgetToken: DEMO_WIDGET_TOKEN,
      },
    });
    expect(res.statusCode).toBe(200);

    // recorded against the account subject...
    expect(await lookupConsent(store, { tenantId: "demo", anonId: accountSubjectId(ATTACKER_SHOPPER_ID) })).toEqual({
      memoryOrdinary: "in",
      memorySpecial: "in",
    });
    // ...and the victim's own subject is completely untouched (fail-closed default).
    expect(await lookupConsent(store, { tenantId: "demo", anonId: VICTIM_ANON_ID })).toEqual({
      memoryOrdinary: "unknown",
      memorySpecial: "unknown",
    });
    await app.close();
  });

  // RE-EXPRESSED (ADR-0019 task 4/9, 2026-08-06) — under task 4 the premise of the ORIGINAL N1 test no
  // longer holds, and the new truth is a genuine STRENGTHENING, not a weakening, so it is re-expressed
  // rather than force-passed.
  //
  // The ORIGINAL test proved: a verified shopper who co-presents a validated `body.anonId` gets that
  // namespace erased too (a DELIBERATE, documented trade-off — the shipped widget's `forgetMe()` sends
  // the shopper token PLUS the just-superseded guest anonId in the request body, and the server cannot
  // tell "my own real guest-era anonId" apart from "a stranger's anonId I obtained", both being a
  // validated string in the body). Invariant 4 removes `body.anonId` from this derivation ENTIRELY — the
  // guest side of /forget (primary subject AND this co-presented-namespace branch alike) now comes ONLY
  // from a VERIFIED `x-guest-token`. A plain client-typed anonId in the body is therefore no longer a
  // credential for ANYTHING here, so the exact attack shape this test used to send (shopper token +
  // `body.anonId: VICTIM_ANON_ID`) can no longer touch the victim's namespace at all — the class of
  // exposure N1 accepted as a trade-off is closed for this transport.
  //
  // The underlying LEGITIMATE capability N1 protected — a signed-in shopper's real pre-sign-in guest-era
  // facts being reachable on "forget everything" — still exists and is exercised, unchanged in spirit,
  // by forget.test.ts's own N1 case, which now presents that guest identity as a valid `x-guest-token`
  // (the post-task-4 widget contract). The exact "no new capability" argument this test made ALSO still
  // holds for that transport: presenting a valid signed `x-guest-token` naming ANY anonId — attacker or
  // not — erases that namespace regardless of whether a shopper token also accompanies it (see "an
  // ANONYMOUS guest is unchanged" below, which pins that ANY caller holding such a token can do this with
  // no shopper token at all). So nothing here is a new hole; it is the OLD hole's transport requirement
  // getting strictly harder (a signed credential, not a typed string).
  it("N1 RE-EXPRESSED — a verified shopper's /forget with a VICTIM anonId in the BODY (no x-guest-token) leaves the victim's namespace untouched: invariant 4 closes the old body-anonId co-presentation trade-off", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const victimNs = subjectNamespace("demo", VICTIM_ANON_ID);
    await vector.upsert(victimNs, [
      {
        id: "victim-1",
        text: "prefers fragrance-free",
        metadata: { text: "prefers fragrance-free", class: "ordinary", expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
      },
    ]);

    const app = await buildServer({ store, vectorPort: vector });
    const res = await app.inject({
      method: "POST",
      url: "/forget",
      headers: { "x-shopper-token": attackerToken() }, // deliberately NO x-guest-token
      payload: { anonId: VICTIM_ANON_ID, widgetToken: DEMO_WIDGET_TOKEN }, // body.anonId is now IGNORED (invariant 4)
    });

    expect(res.statusCode).toBe(200);
    // The victim's namespace is genuinely untouched — a bare body.anonId never reached the guest-subject
    // derivation at all.
    const survivors = await vector.query(victimNs, { text: "", k: 10 });
    expect(survivors.map((s) => s.id)).toEqual(["victim-1"]);
    // Only the attacker's OWN (empty) account subject was erased — one audit entry, not two.
    const log = await store.readAudit({ tenantId: "demo" });
    expect(log.filter((r) => r.action === "erase.subject").length).toBe(1);
    await app.close();
  });


  // SECURITY REVIEW F1 — the surface the first cut MISSED. Binding /consent, remember() and the sweep
  // was not enough: the brain's RECALL path reads `memory.recall({ anonId: signals.anonId })`, and
  // `signals.anonId` was still the raw client value. A verified shopper could therefore supply a
  // victim's anonId and have the VICTIM's namespace queried and their fact text injected into the model
  // prompt — i.e. real READ access, which the go-live checklist had asserted did not exist. Worse, the
  // read-time consent gate was then evaluated against the CALLER's consent record (which the caller
  // sets themselves) rather than the record belonging to the facts being read (F2).
  //
  // No test in the repo combined SHOPPER_AUTH + memoryEnabled + recall, which is exactly why 1166 tests
  // stayed green with the hole wide open. This is that test.
  it("THE ATTACK (recall): a verified shopper supplying a victim's anonId never queries the victim's namespace nor leaks their fact text", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const victimNs = subjectNamespace("demo", VICTIM_ANON_ID);
    await vector.upsert(victimNs, [
      {
        id: "victim-secret",
        text: "shopper is allergic to tree nuts",
        metadata: { text: "shopper is allergic to tree nuts", class: "ordinary", expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
      },
    ]);
    const queried: string[] = [];
    const origQuery = vector.query.bind(vector);
    vi.spyOn(vector, "query").mockImplementation(async (ns: string, q: never) => {
      queried.push(ns);
      return origQuery(ns, q);
    });
    const modelCalls: ModelRequest[] = [];
    const modelPort: ModelPort = {
      async complete(req: ModelRequest) {
        modelCalls.push(req);
        return { text: "ok", model: "spy" };
      },
    };

    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      headers: { "x-shopper-token": attackerToken() },
      payload: {
        sessionId: "attack-recall-1",
        message: "what do you remember about me?",
        signals: { cart: "empty", anonId: VICTIM_ANON_ID }, // the victim's id, supplied by the attacker
        widgetToken: DEMO_WIDGET_TOKEN,
      },
    });
    expect(res.statusCode).toBe(200);

    // The victim's namespace must never be read...
    expect(queried).not.toContain(victimNs);
    // ...and none of their fact text may reach the model prompt.
    const everythingSent = modelCalls.flatMap((c) => c.messages.map((m) => m.content)).join(" ");
    expect(everythingSent).not.toContain("tree nuts");
    await app.close();
  });

  it("THE ATTACK (recall), NO TOKEN AT ALL: a caller with no shopper AND no guest token cannot recall by naming a victim's anonId (invariant 4 — the signals.ts fallback the tasks-4/9 review caught)", async () => {
    // The reviewer's uncovered case: memory ON, no x-shopper-token, no x-guest-token, just a client
    // signals.anonId = victim. Before the fix, `deriveServingSignals` fell back to the client anonId
    // (signals.ts) so recall keyed off it. Now memorySubject is undefined ⇒ signals.anonId undefined ⇒
    // no recall, no read of the victim namespace.
    armAuth();
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const victimNs = subjectNamespace("demo", VICTIM_ANON_ID);
    await vector.upsert(victimNs, [
      {
        id: "victim-secret",
        text: "shopper is allergic to tree nuts",
        metadata: { text: "shopper is allergic to tree nuts", class: "ordinary", expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
      },
    ]);
    const queried: string[] = [];
    const origQuery = vector.query.bind(vector);
    vi.spyOn(vector, "query").mockImplementation(async (ns: string, q: never) => {
      queried.push(ns);
      return origQuery(ns, q);
    });
    const modelCalls: ModelRequest[] = [];
    const modelPort: ModelPort = { async complete(req: ModelRequest) { modelCalls.push(req); return { text: "ok", model: "spy" }; } };
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      // NO x-shopper-token, NO x-guest-token — only the merchant widget token and a client-named anonId.
      payload: {
        sessionId: "attack-recall-notoken",
        message: "what do you remember about me?",
        signals: { cart: "empty", anonId: VICTIM_ANON_ID },
        widgetToken: DEMO_WIDGET_TOKEN,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(queried, "the victim namespace was read from a bare client anonId — invariant 4 fallback").not.toContain(victimNs);
    const everythingSent = modelCalls.flatMap((c) => c.messages.map((m) => m.content)).join(" ");
    expect(everythingSent).not.toContain("tree nuts");
    await app.close();
  });

  // REVISED (ADR-0019 task 4/9) — this test's premise changed: a guest no longer gets ANY subject from a
  // bare client-supplied anonId. The guest subject now comes EXCLUSIVELY from a VERIFIED `x-guest-token`
  // (invariant 4). Intent preserved: a guest presenting a valid token for THEIR OWN anonId can still
  // erase it (the underlying capability is unchanged); a guest presenting nothing — just a bare string —
  // gets NO subject at all. "A stranger's [id] cannot be asserted via a bare client string" now holds
  // even more strongly than before: a bare string is no longer even sufficient to assert ONE'S OWN id.
  it("an ANONYMOUS guest is unchanged — no verified principal, so a VALID x-guest-token is still the subject (a bare client string alone no longer is)", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const ns = subjectNamespace("demo", VICTIM_ANON_ID);
    await vector.upsert(ns, [
      {
        id: "guest-1",
        text: "prefers fragrance-free",
        metadata: { text: "prefers fragrance-free", class: "ordinary", expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
      },
    ]);

    const app = await buildServer({ store, vectorPort: vector });

    // A bare client-supplied anonId with NO token is no longer enough to name any subject at all — the
    // record must survive an unaccompanied body.anonId.
    const bare = await app.inject({
      method: "POST",
      url: "/forget",
      payload: { anonId: VICTIM_ANON_ID, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(bare.statusCode).toBe(400);
    expect(await vector.query(ns, { text: "", k: 10 })).not.toEqual([]);

    // With a VALID x-guest-token for that SAME anonId — no x-shopper-token at all — the guest still owns
    // and may erase this subject: the underlying capability is unchanged, only the credential got
    // stronger.
    const res = await app.inject({
      method: "POST",
      url: "/forget",
      headers: guestTokenHeader(GUEST_SECRET, "demo", VICTIM_ANON_ID),
      payload: { widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(await vector.query(ns, { text: "", k: 10 })).toEqual([]); // genuinely erased
    await app.close();
  });

  // RELABELED (security-review remediation, PR #152, §5 LOW) — this exercises only the INVALID/malformed
  // token path (`authenticate` rejects it outright -> `kind !== "shopper"`), NOT an "unverified" shopper.
  // `createShopperTokenIdentity`'s adapter never returns `verified: false` — its Principal type makes
  // `verified` a literal `true` on the `shopper` kind (platform-ports/identity-port.ts), so ANY failure
  // (tampered, wrong `typ`, expired, unconfigured secret) resolves to `kind: "anonymous"` instead. The
  // defensive `!resolved.verified` guard in `verifiedShopperIdFor` is therefore unreachable via this
  // adapter and NOT exercised by this test — it stays in the code as defense-in-depth for a future
  // IdentityPort adapter that COULD return `verified: false`, and is deliberately not removed.
  it("an invalid/malformed shopper token does not authorize an account subject — it falls back to the guest path", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store, vectorPort: createInMemoryVectorStore() });

    // ADR-0019 task 4/9 — the guest subject now comes ONLY from a VERIFIED `x-guest-token`, never
    // `body.anonId` (invariant 4); the property under test (an invalid shopper token doesn't authorize
    // an account subject) is orthogonal to that transport, so it is exercised the same way here.
    const res = await app.inject({
      method: "POST",
      url: "/consent",
      headers: { "x-shopper-token": "not-a-real-token", ...guestTokenHeader(GUEST_SECRET, "demo", VICTIM_ANON_ID) },
      payload: { memoryOrdinary: "in", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    // Recorded against the ANON subject (guest path), and no account subject was invented.
    expect((await lookupConsent(store, { tenantId: "demo", anonId: VICTIM_ANON_ID })).memoryOrdinary).toBe("in");
    await app.close();
  });

  it("a shopper token minted for ANOTHER tenant is rejected (cross-shop replay) — no account subject is used", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store, vectorPort: createInMemoryVectorStore() });
    const foreignToken = mintShopperToken(SHOPPER_SECRET, "shopify:other-tenant:x", "shopify", 3_600);

    // ADR-0019 task 4/9 — same rationale as above: the guest subject now needs a verified x-guest-token.
    const res = await app.inject({
      method: "POST",
      url: "/consent",
      headers: { "x-shopper-token": foreignToken, ...guestTokenHeader(GUEST_SECRET, "demo", VICTIM_ANON_ID) },
      payload: { memoryOrdinary: "in", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    // Fell back to the guest path; nothing was written under the foreign shopper's account subject.
    expect(await lookupConsent(store, { tenantId: "demo", anonId: accountSubjectId("shopify:other-tenant:x") })).toEqual({
      memoryOrdinary: "unknown",
      memorySpecial: "unknown",
    });
    await app.close();
  });
});
