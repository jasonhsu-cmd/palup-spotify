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

function makeApp(over: Partial<{ verify: OidcVerifier; remember: Remember }> = {}) {
  const remembered: Array<[MemoryCtx, MemoryTurn]> = [];
  const f = Fastify();
  registerMemoryWritePushRoute(f, {
    verify: over.verify ?? (async (tok) => (tok === "good" ? { email: SA } : null)),
    expectedServiceAccount: SA,
    remember: over.remember ?? (async (ctx, turn) => { remembered.push([ctx, turn]); }),
  });
  return { f, remembered };
}

const encodeData = (payload: unknown) => Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
const envelope = (data?: string) => ({ message: { attributes: {}, ...(data !== undefined ? { data } : {}) } });
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
});
