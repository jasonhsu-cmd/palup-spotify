import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { InMemoryRuntimeStore, createInMemoryVectorStore, mintWidgetToken, mintShopperToken } from "@palup/platform-ports";
import type { ModelPort, ModelRequest } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";
import { guestTokenHeader } from "./helpers/guest-token.js";

// BLOCK-2 (security-review remediation, PR #152) — the shipped widget (packages/widget/public/index.html)
// sends `x-shopper-token` on /chat but NOT on /consent or /forget, so a signed-in shopper's own
// destructive erase request looked ANONYMOUS to the server and erased the (usually empty) guest subject
// instead of their real `acct:<shopperId>` data — while the UI still confirmed "Done — I've cleared what
// I remembered and started fresh." (index.html). Proven by execution: /forget returns 200 {ok:true} and
// the fact survives. The fix is CLIENT-SIDE (index.html now also sends x-shopper-token on /consent and
// /forget, mirroring /chat) — the server-side derivation (verifiedShopperIdFor) already reads the header
// correctly on all three routes; see e2e/tests/widget.spec.ts for the browser-level red->green proof that
// the header is actually sent. This file proves the SERVER SIDE of the contract end-to-end: given the
// FIXED request shape (x-shopper-token present), a signed-in shopper's own destructive erase genuinely
// erases their account-subject data, and the OLD (header-omitting) request shape genuinely does NOT.

const WIDGET_SECRET = "wsecret";
const SHOPPER_SECRET = "shopper-secret";
const DEMO_WIDGET_TOKEN = mintWidgetToken(WIDGET_SECRET, "demo", 3_600);
const SHOPPER_ID = "shopify:demo:77001";
const GUEST_ANON_ID = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // base32, passes validateAnonId

const ENV_KEYS = ["WIDGET_TOKEN_SECRET", "WIDGET_AUTH_REQUIRED", "SHOPPER_AUTH", "SHOPPER_TOKEN_SECRET", "GUEST_TOKEN_SECRET"];
afterEach(() => ENV_KEYS.forEach((k) => delete process.env[k]));
// ADR-0019 task 4/9 — the guest memory subject now comes ONLY from a VERIFIED `x-guest-token`.
const GUEST_SECRET = "gsecret";

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

describe("BLOCK-2 — POST /forget must reach the account subject for a signed-in shopper", () => {
  it("THE REVIEWER'S SCENARIO (pre-fix client shape): /forget WITHOUT x-shopper-token returns {ok:true} but the account subject's fact SURVIVES", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    // The shopper signs in and chats — an ordinary fact is written under acct:<shopperId>.
    await app.inject({
      method: "POST",
      url: "/chat",
      headers: { "x-shopper-token": shopperToken() },
      payload: { sessionId: "acct-write-1", message: "I like fragrance-free stuff", signals: { anonId: GUEST_ANON_ID }, widgetToken: DEMO_WIDGET_TOKEN },
    });
    const acctNs = "demo::acct:" + SHOPPER_ID;
    expect((await vector.query(acctNs, { text: "", k: 10 })).length).toBeGreaterThan(0);

    // The OLD (buggy) forgetMe() request shape: content-type + widget Bearer only, NO x-shopper-token —
    // exactly what packages/widget/public/index.html sent before the client-side fix. (ADR-0019 task 4/9:
    // the guest id itself must now travel as a VERIFIED `x-guest-token`, not `body.anonId` — invariant 4 —
    // so this otherwise-unauthenticated call presents ITS OWN guest token to reach a real guest subject;
    // the point under test — no x-shopper-token means the ACCOUNT subject is never reached — is unchanged.)
    const res = await app.inject({
      method: "POST",
      url: "/forget",
      headers: guestTokenHeader(GUEST_SECRET, "demo", GUEST_ANON_ID),
      payload: { widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true }); // the UI would report success here...
    // ...while the shopper's REAL data survives untouched. This is the defect the reviewers proved.
    expect((await vector.query(acctNs, { text: "", k: 10 })).length).toBeGreaterThan(0);

    await app.close();
  });

  it("THE FIX: /forget WITH x-shopper-token (mirroring the fixed forgetMe()) genuinely erases the account subject's data end-to-end", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    await app.inject({
      method: "POST",
      url: "/chat",
      headers: { "x-shopper-token": shopperToken() },
      payload: { sessionId: "acct-write-2", message: "I like fragrance-free stuff", signals: { anonId: GUEST_ANON_ID }, widgetToken: DEMO_WIDGET_TOKEN },
    });
    const acctNs = "demo::acct:" + SHOPPER_ID;
    expect((await vector.query(acctNs, { text: "", k: 10 })).length).toBeGreaterThan(0);

    // The FIXED forgetMe() request shape: the same body, PLUS x-shopper-token (the widget holds the
    // token already — it already sends it on /chat).
    const res = await app.inject({
      method: "POST",
      url: "/forget",
      headers: { "x-shopper-token": shopperToken() },
      payload: { anonId: GUEST_ANON_ID, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    // The account subject's data is genuinely gone.
    expect((await vector.query(acctNs, { text: "", k: 10 })).length).toBe(0);
    const log = await store.readAudit({ tenantId: "demo" });
    expect(log.map((r) => r.action)).toContain("erase.subject");

    await app.close();
  });

  // MEDIUM finding (security-review remediation, PR #152) — an `acct:` subject id is LOW-ENTROPY
  // (widget-backend/src/audit.ts's own `hashShopperRef` rule), so its erase.subject audit `subjectRef`
  // must be a KEYED HMAC, not a bare hash. SHOPPER_TOKEN_SECRET alone (no separate AUDIT_HMAC_SECRET) is
  // enough, since AUDIT_HMAC_SECRET defaults to it.
  it("the erase.subject audit subjectRef for an acct: subject is a KEYED HMAC, not a bare hash", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    await app.inject({
      method: "POST",
      url: "/chat",
      headers: { "x-shopper-token": shopperToken() },
      payload: { sessionId: "acct-write-3", message: "I like fragrance-free stuff", signals: { anonId: GUEST_ANON_ID }, widgetToken: DEMO_WIDGET_TOKEN },
    });
    await app.inject({
      method: "POST",
      url: "/forget",
      headers: { "x-shopper-token": shopperToken() },
      payload: { anonId: GUEST_ANON_ID, widgetToken: DEMO_WIDGET_TOKEN },
    });

    const log = await store.readAudit({ tenantId: "demo" });
    const entry = log.find((r) => r.action === "erase.subject");
    const keyedRef = (entry?.input as { subjectRef?: string } | undefined)?.subjectRef;
    expect(keyedRef).toBeTruthy();

    // The OLD unkeyed-hash ref for the identical (tenantId, subject) — audit.ts's own `subjectRef`
    // formula before an hmacKey is applied (sha256, truncated to 16 hex chars). A genuinely keyed ref
    // must differ from this, not merely be SOME string.
    const unkeyedRef = createHash("sha256").update(`demo::acct:${SHOPPER_ID}`).digest("hex").slice(0, 16);
    expect(keyedRef).not.toBe(unkeyedRef);

    await app.close();
  });
});
