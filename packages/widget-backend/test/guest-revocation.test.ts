import { describe, it, expect, afterEach, vi } from "vitest";
import { InMemoryRuntimeStore, createInMemoryVectorStore, mintWidgetToken } from "@palup/platform-ports";
import type { ModelPort, ModelRequest } from "@palup/platform-ports";
import { subjectNamespace } from "@palup/widget-memory";
import { revokeGuest, isGuestRevoked } from "@palup/state-postgres";
import { buildServer } from "../src/server.js";
import { craftGuestToken, guestTokenHeader } from "./helpers/guest-token.js";

// ADR-0019 Revision 2, Task 5 / R2-7 — guest-credential revocation, tested through the real HTTP surface.
// Three properties:
//   • INVARIANT 8 — a REVOKED aid verifies as anonymous: `guestAnonIdFrom` returns no subject, so /chat
//     never even QUERIES that namespace (recall needs a subject). Proven at the vector-query seam, with a
//     LIVE-aid control to show the mechanism recalls when NOT revoked (so the negative isn't a fluke).
//   • IC-1 — RENEW never resurrects a revoked aid: `POST /widget/guest` presented a revoked token mints a
//     FRESH id instead of renewing the revoked one.
//   • END-TO-END — forget-me WRITES the revocation: after `POST /forget` the aid is revoked, and a later
//     RENEW on the same token mints fresh (IC-1 reading the record forget wrote).

const WIDGET_SECRET = "wsecret";
const GUEST_SECRET = "gsecret";
const TENANT = "demo";
const DEMO_WIDGET_TOKEN = mintWidgetToken(WIDGET_SECRET, TENANT, 3_600);
const FUTURE = () => new Date(Date.now() + 86_400_000).toISOString();

// Distinct, well-formed base32 aids (validateAnonId: /^[A-Z2-7]{10,64}$/).
const REVOKED_AID = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const LIVE_AID = "GHIJKLMNOPQRSTUVWXYZ234567ABCDEF";
const FORGET_AID = "MNOPQRSTUVWXYZ234567ABCDEFGHIJKL";

const ENV = ["WIDGET_TOKEN_SECRET", "WIDGET_AUTH_REQUIRED", "GUEST_TOKEN_SECRET"];
afterEach(() => {
  ENV.forEach((k) => delete process.env[k]);
  vi.restoreAllMocks();
});
function arm(): void {
  process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
  process.env.WIDGET_AUTH_REQUIRED = "true";
  process.env.GUEST_TOKEN_SECRET = GUEST_SECRET;
}

const seedFact = (vector: ReturnType<typeof createInMemoryVectorStore>, aid: string) =>
  vector.upsert(subjectNamespace(TENANT, aid), [
    { id: `seed-${aid}`, text: "shopper is allergic to tree nuts", metadata: { text: "shopper is allergic to tree nuts", class: "ordinary", expiresAt: FUTURE() } },
  ]);

const chat = (app: Awaited<ReturnType<typeof buildServer>>, aidToken: Record<string, string>, sessionId: string) =>
  app.inject({
    method: "POST",
    url: "/chat",
    headers: aidToken,
    payload: { sessionId, message: "what do you remember about me?", signals: {}, widgetToken: DEMO_WIDGET_TOKEN },
  });

const renew = async (app: Awaited<ReturnType<typeof buildServer>>, guestToken: string) =>
  JSON.parse((await app.inject({ method: "POST", url: "/widget/guest", headers: { authorization: `Bearer ${DEMO_WIDGET_TOKEN}` }, payload: { guestToken } })).body);

describe("ADR-0019 Task 5 — invariant 8: a REVOKED aid verifies as anonymous (no recall)", () => {
  it("never queries a revoked aid's namespace, while a LIVE aid with the identical fact IS recalled", async () => {
    arm();
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    await seedFact(vector, REVOKED_AID);
    await seedFact(vector, LIVE_AID);
    await revokeGuest(store, { tenantId: TENANT, anonId: REVOKED_AID }); // the effect forget-me will have

    // Tracks BOTH vector-port read ops `recall()` might take: `query` (the semantic-ranked path, or the
    // pre-pgvector-fix fallback) and `list` (the pgvector-safe fallback list-all this package's memory
    // service uses today — see widget-memory/src/service.ts `recall`'s fallback branch). This test's
    // MEMORY_SEMANTIC_RECALL is off (not armed), so the LIVE control below exercises the fallback, i.e.
    // `list` — spying on `query` alone would no longer observe it and falsely look like invariant 8 broke.
    const queried: string[] = [];
    const origQuery = vector.query.bind(vector);
    vi.spyOn(vector, "query").mockImplementation(async (ns: string, q: never) => {
      queried.push(ns);
      return origQuery(ns, q);
    });
    const origList = vector.list.bind(vector);
    vi.spyOn(vector, "list").mockImplementation(async (ns: string, opts: never) => {
      queried.push(ns);
      return origList(ns, opts);
    });
    const modelCalls: ModelRequest[] = [];
    const modelPort: ModelPort = { async complete(req: ModelRequest) { modelCalls.push(req); return { text: "ok", model: "spy" }; } };
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });
    try {
      // REVOKED: no subject derived ⇒ recall never touches the namespace, and no fact reaches the model.
      const r1 = await chat(app, guestTokenHeader(GUEST_SECRET, TENANT, REVOKED_AID), "s-revoked");
      expect(r1.statusCode).toBe(200);
      expect(queried, "a revoked aid's namespace was queried — invariant 8 broken").not.toContain(subjectNamespace(TENANT, REVOKED_AID));
      expect(modelCalls.flatMap((c) => c.messages.map((m) => m.content)).join(" ")).not.toContain("tree nuts");

      // CONTROL — a LIVE aid with the SAME seeded fact: the subject IS derived, so its namespace IS read.
      // Proves the negative above is real revocation, not "recall never runs in this test".
      await chat(app, guestTokenHeader(GUEST_SECRET, TENANT, LIVE_AID), "s-live");
      expect(queried, "a live aid's namespace was not read — recall is broken and the test proves nothing").toContain(subjectNamespace(TENANT, LIVE_AID));
    } finally {
      await app.close();
    }
  });
});

describe("ADR-0019 Task 5 — IC-1: RENEW never resurrects a revoked aid", () => {
  it("a non-revoked token renews to the SAME aid; once revoked, RENEW mints a FRESH aid", async () => {
    arm();
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store, memoryEnabled: true });
    try {
      const first = JSON.parse((await app.inject({ method: "POST", url: "/widget/guest", headers: { authorization: `Bearer ${DEMO_WIDGET_TOKEN}` }, payload: {} })).body);
      expect(first.anonId).toBeTruthy();

      // control: a LIVE token renews to the same id (R2-3), so the revoked-case difference is meaningful.
      expect((await renew(app, first.guestToken)).anonId).toBe(first.anonId);

      // revoke it, then RENEW the very same token → must NOT return the revoked id.
      await revokeGuest(store, { tenantId: TENANT, anonId: first.anonId });
      const afterRevoke = await renew(app, first.guestToken);
      expect(afterRevoke.anonId, "RENEW resurrected a revoked aid — IC-1 broken").not.toBe(first.anonId);
      expect(afterRevoke.guestToken, "RENEW should still hand back a fresh valid guest token").toBeTruthy();
    } finally {
      await app.close();
    }
  });
});

describe("ADR-0019 Task 5 — forget-me WRITES the revocation (end to end)", () => {
  it("after POST /forget the guest aid is revoked, and a later RENEW on the same token mints fresh", async () => {
    arm();
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const token = craftGuestToken(GUEST_SECRET, TENANT, FORGET_AID);
    await seedFact(vector, FORGET_AID); // so the erase has something to erase
    const app = await buildServer({ store, vectorPort: vector, memoryEnabled: true });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/forget",
        headers: { authorization: `Bearer ${DEMO_WIDGET_TOKEN}`, "x-guest-token": token },
        payload: {},
      });
      expect(res.statusCode).toBe(200);

      // The record forget wrote — keyed on the token-derived aid, not any client string.
      expect(await isGuestRevoked(store, { tenantId: TENANT, anonId: FORGET_AID })).toBe(true);
      // ...and the facts are gone (the load-bearing data-rights action still happened).
      expect(await vector.query(subjectNamespace(TENANT, FORGET_AID), { text: "", k: 10 })).toEqual([]);

      // End-to-end: RENEW on the forgotten token now mints fresh — IC-1 consulted forget's record.
      expect((await renew(app, token)).anonId).not.toBe(FORGET_AID);
    } finally {
      await app.close();
    }
  });
});
