import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { registerMemoryWritePushRoute, MEMORY_PUSH_ROUTE } from "../src/routes/pubsub-push-memory.js";
import type { OidcVerifier } from "../src/routes/oidc-push-route.js";
import type { MemoryCtx, MemoryTurn } from "@palup/widget-memory";

// #126 W1.3 — the OIDC-gated Pub/Sub push route for the async memory-write queue. Mirrors
// pubsub-push.test.ts: same fail-closed rate-limit → OIDC → expected-SA gate (shared core), a different
// domain action. Tenant isolation for THIS route comes from the BODY (server-authored), not the
// `tenantKey` attribute (which is the publish-side subject key for QueuePort ordering, not authority
// here) — so there is no safe default write when the body is malformed or subject-less.
const SA = "pubsub-memory-push@proj.iam.gserviceaccount.com";

type Remember = (ctx: MemoryCtx, turn: MemoryTurn) => Promise<unknown>;
type AlreadyProcessed = (tenantId: string, id: string) => Promise<boolean>;
type MarkProcessed = (tenantId: string, id: string) => Promise<void>;
type WasErasedAfter = (tenantId: string, anonId: string, publishedAtMs: number) => Promise<boolean>;

function makeApp(
  over: Partial<{
    verify: OidcVerifier;
    remember: Remember;
    alreadyProcessed: AlreadyProcessed;
    markProcessed: MarkProcessed;
    wasErasedAfter: WasErasedAfter;
  }> = {},
) {
  const remembered: Array<[MemoryCtx, MemoryTurn]> = [];
  const marked: Array<[string, string]> = [];
  const f = Fastify();
  registerMemoryWritePushRoute(f, {
    verify: over.verify ?? (async (tok) => (tok === "good" ? { email: SA } : null)),
    expectedServiceAccount: SA,
    remember: over.remember ?? (async (ctx, turn) => { remembered.push([ctx, turn]); }),
    ...(over.alreadyProcessed ? { alreadyProcessed: over.alreadyProcessed } : {}),
    ...(over.markProcessed
      ? { markProcessed: (tenantId: string, id: string) => { marked.push([tenantId, id]); return over.markProcessed!(tenantId, id); } }
      : {}),
    ...(over.wasErasedAfter ? { wasErasedAfter: over.wasErasedAfter } : {}),
  });
  return { f, remembered, marked };
}

const encodeData = (payload: unknown) => Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
const envelope = (data?: string, attributes: Record<string, string> = {}) => ({ message: { attributes, ...(data !== undefined ? { data } : {}) } });
const post = (f: ReturnType<typeof Fastify>, headers: Record<string, string>, payload: unknown) =>
  f.inject({ method: "POST", url: MEMORY_PUSH_ROUTE, headers, payload });

const VALID_BODY = {
  tenantId: "acme",
  anonId: "anon-1",
  region: "us" as const,
  consent1: "in" as const,
  consent2: "unknown" as const,
  message: "do you have this in blue?",
  reply: "yes, in stock",
  publishedAt: 1_700_000_000_000,
};

describe("W1.3 — memory-write Pub/Sub push route (OIDC-gated)", () => {
  it("valid OIDC + expected SA + well-formed body ⇒ remember called with the exact ctx/turn, 204", async () => {
    const { f, remembered } = makeApp();
    const res = await post(f, { authorization: "Bearer good" }, envelope(encodeData(VALID_BODY)));
    expect(res.statusCode).toBe(204);
    expect(remembered).toEqual([
      [
        { tenantId: "acme", anonId: "anon-1", region: "us", consent1: "in", consent2: "unknown" },
        { message: "do you have this in blue?", reply: "yes, in stock" },
      ],
    ]);
  });

  it("missing bearer ⇒ 401, no remember", async () => {
    const { f, remembered } = makeApp();
    const res = await post(f, {}, envelope(encodeData(VALID_BODY)));
    expect(res.statusCode).toBe(401);
    expect(remembered).toEqual([]);
  });

  it("valid Google signature but WRONG service account ⇒ 401", async () => {
    const { f, remembered } = makeApp({ verify: async () => ({ email: "attacker@evil.iam.gserviceaccount.com" }) });
    const res = await post(f, { authorization: "Bearer good" }, envelope(encodeData(VALID_BODY)));
    expect(res.statusCode).toBe(401);
    expect(remembered).toEqual([]);
  });

  it("verify throws (bad/expired token) ⇒ 401", async () => {
    const { f, remembered } = makeApp({ verify: async () => { throw new Error("invalid token"); } });
    const res = await post(f, { authorization: "Bearer bad" }, envelope(encodeData(VALID_BODY)));
    expect(res.statusCode).toBe(401);
    expect(remembered).toEqual([]);
  });

  it("malformed base64 ⇒ 204 ack+drop, no remember (no safe default write)", async () => {
    const { f, remembered } = makeApp();
    const res = await post(f, { authorization: "Bearer good" }, envelope("%%%not-base64%%%"));
    expect(res.statusCode).toBe(204);
    expect(remembered).toEqual([]);
  });

  it("valid base64 but INVALID JSON ⇒ 204 ack+drop, no remember", async () => {
    const { f, remembered } = makeApp();
    const data = Buffer.from("{not valid json", "utf8").toString("base64");
    const res = await post(f, { authorization: "Bearer good" }, envelope(data));
    expect(res.statusCode).toBe(204);
    expect(remembered).toEqual([]);
  });

  it("absent message.data ⇒ 204 ack+drop, no remember", async () => {
    const { f, remembered } = makeApp();
    const res = await post(f, { authorization: "Bearer good" }, envelope());
    expect(res.statusCode).toBe(204);
    expect(remembered).toEqual([]);
  });

  it.each(["tenantId", "anonId", "message", "reply"] as const)(
    "missing %s ⇒ 204 ack+drop, no remember (no subject-less/incomplete write)",
    async (field) => {
      const { f, remembered } = makeApp();
      const body = { ...VALID_BODY, [field]: undefined };
      const res = await post(f, { authorization: "Bearer good" }, envelope(encodeData(body)));
      expect(res.statusCode).toBe(204);
      expect(remembered).toEqual([]);
    },
  );

  it.each(["tenantId", "anonId", "message", "reply"] as const)(
    "blank %s ⇒ 204 ack+drop, no remember",
    async (field) => {
      const { f, remembered } = makeApp();
      const body = { ...VALID_BODY, [field]: "   " };
      const res = await post(f, { authorization: "Bearer good" }, envelope(encodeData(body)));
      expect(res.statusCode).toBe(204);
      expect(remembered).toEqual([]);
    },
  );

  it("remember throws ⇒ 500 so Pub/Sub retries (then dead-letters server-side)", async () => {
    const { f } = makeApp({ remember: async () => { throw new Error("db down"); } });
    const res = await post(f, { authorization: "Bearer good" }, envelope(encodeData(VALID_BODY)));
    expect(res.statusCode).toBe(500);
  });

  describe("E2 — consume-side idempotency dedup", () => {
    it("the SAME attributes.id delivered twice ⇒ remember called ONCE; both responses 204", async () => {
      const processed = new Set<string>();
      const { f, remembered } = makeApp({
        alreadyProcessed: async (_tenantId, id) => processed.has(id),
        markProcessed: async (_tenantId, id) => { processed.add(id); },
      });
      const env = envelope(encodeData(VALID_BODY), { id: "turn-1" });
      const res1 = await post(f, { authorization: "Bearer good" }, env);
      const res2 = await post(f, { authorization: "Bearer good" }, env);
      expect(res1.statusCode).toBe(204);
      expect(res2.statusCode).toBe(204);
      expect(remembered).toHaveLength(1);
    });

    it("mark-AFTER-success: a `remember` that throws once then succeeds ⇒ first delivery 500 and NOT marked; redelivery calls remember again (a failed write is retried, not swallowed)", async () => {
      let calls = 0;
      const processed = new Set<string>();
      const { f, remembered } = makeApp({
        remember: async (ctx, turn) => {
          calls++;
          if (calls === 1) throw new Error("distiller down");
        },
        alreadyProcessed: async (_tenantId, id) => processed.has(id),
        markProcessed: async (_tenantId, id) => { processed.add(id); },
      });
      const env = envelope(encodeData(VALID_BODY), { id: "turn-2" });
      const res1 = await post(f, { authorization: "Bearer good" }, env);
      expect(res1.statusCode).toBe(500);
      expect(processed.has("turn-2")).toBe(false);

      const res2 = await post(f, { authorization: "Bearer good" }, env);
      expect(res2.statusCode).toBe(204);
      expect(calls).toBe(2); // redelivery re-ran remember — a failed write is retried, not marked-away
      void remembered;
    });
  });

  describe("E1 — erasure tombstone drop", () => {
    it("wasErasedAfter true (published at/before the tombstone) ⇒ 204, remember NOT called", async () => {
      const { f, remembered } = makeApp({ wasErasedAfter: async () => true });
      const res = await post(f, { authorization: "Bearer good" }, envelope(encodeData(VALID_BODY)));
      expect(res.statusCode).toBe(204);
      expect(remembered).toEqual([]);
    });

    it("wasErasedAfter false (published after erasure / no tombstone) ⇒ remember called", async () => {
      const { f, remembered } = makeApp({ wasErasedAfter: async () => false });
      const res = await post(f, { authorization: "Bearer good" }, envelope(encodeData(VALID_BODY)));
      expect(res.statusCode).toBe(204);
      expect(remembered).toHaveLength(1);
    });

    it("LOW-1 — a message with NO publishedAt still consults the tombstone (fails closed, publishedAt→0)", async () => {
      let calledWith: number | undefined;
      const { f, remembered } = makeApp({
        wasErasedAfter: async (_t, _a, publishedAtMs) => { calledWith = publishedAtMs; return true; },
      });
      const { publishedAt: _drop, ...bodyNoPublishedAt } = VALID_BODY;
      const res = await post(f, { authorization: "Bearer good" }, envelope(encodeData(bodyNoPublishedAt)));
      expect(res.statusCode).toBe(204);
      expect(remembered).toEqual([]); // dropped by the tombstone even without a publishedAt
      expect(calledWith).toBe(0); // a missing publishedAt is treated as the oldest possible time
    });
  });
});
