import type { FastifyInstance } from "fastify";
import type { MemoryCtx, MemoryTurn } from "@palup/widget-memory";
import { registerOidcPushRoute, type OidcVerifier } from "./oidc-push-route.js";

// #126 W1.3 — the OIDC-gated Pub/Sub push route for the async memory-write queue (dispatchMemoryWrite /
// memory-write-queue.ts). Built on the same shared `registerOidcPushRoute` core as pubsub-push.ts's
// catalog route: identical fail-closed rate-limit → OIDC → expected-SA gate, a different domain action.
//
// Tenant isolation here comes from the BODY, not the `tenantKey` attribute: the publish side
// (memory-write-queue.ts) sets `tenantKey` to `ctx.anonId` for QueuePort per-SUBJECT publish ordering, so
// for THIS route the attribute is a subject key, not authority for isolation — tenantId/anonId are
// read from the server-authored JSON body instead. `remember()`'s own consent gate (widget-memory's
// `decideMemoryWrite`) is what enforces the write decision; this route's only job is fail-closed delivery.
//
// There is deliberately no partial/default write: a message missing tenantId, anonId, message, or reply
// can never be written safely (there is no subject to attribute the fact to), so it is ack-and-dropped
// (204) rather than retried forever or written with a guessed subject.

export const MEMORY_PUSH_ROUTE = "/internal/pubsub/memory-write" as const;

interface MemoryWritePayload {
  tenantId?: unknown;
  anonId?: unknown;
  region?: unknown;
  consent1?: unknown;
  consent2?: unknown;
  message?: unknown;
  reply?: unknown;
  /** §E1 — the publish-side clock (memory-write-queue.ts's `nowMs`), used to check against an erasure
   *  tombstone written AFTER this message was published. */
  publishedAt?: unknown;
}

export interface MemoryWritePushDeps {
  verify: OidcVerifier;
  /** The exact service-account email Pub/Sub is configured to push as for this route. A verified token
   *  from ANY OTHER Google identity is refused. */
  expectedServiceAccount: string;
  /** The existing memory write — the same call every inline caller makes today (widget-memory's own
   *  double gate + consent decision, `decideMemoryWrite`, is untouched; this route is just a new caller
   *  reached from the async queue instead of the hot /chat path). */
  remember: (ctx: MemoryCtx, turn: MemoryTurn) => Promise<unknown>;
  /** Same per-IP limiter every public route uses. `false` ⇒ refuse (fail-closed). Optional. */
  checkRateLimit?: (ip: string) => Promise<boolean>;
  /** §E2 (consume-side idempotency dedup) — has this message's deterministic `id` (Pub/Sub message
   *  attribute, set by memory-write-queue.ts) already been written? Optional: omitted means no dedup
   *  check runs (the pre-#331 dark path), so existing callers/tests are unaffected. */
  alreadyProcessed?: (tenantId: string, id: string) => Promise<boolean>;
  /** §E2 — marks `id` processed. Called ONLY after `remember` resolves, never before/instead of it, so a
   *  throwing `remember` (⇒ 500, Pub/Sub retries) is never mistaken for a completed write. Optional. */
  markProcessed?: (tenantId: string, id: string) => Promise<void>;
  /** §E1 (erasure tombstone) — was this subject erased/withdrawn at or after `publishedAtMs`? `true` ⇒
   *  ack + drop (the shopper asked to be forgotten before or as this message was published; writing it
   *  now would silently re-create the erased fact). Optional. */
  wasErasedAfter?: (tenantId: string, anonId: string, publishedAtMs: number) => Promise<boolean>;
}

function isNonBlankString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** Any value other than the two known tri-state signals fails closed to "unknown" (ADR-0015 Inv 3/9 — the
 *  same fail-closed posture `decideMemoryWrite` applies to a missing/garbage consent signal). */
function asConsent(v: unknown): MemoryCtx["consent1"] {
  return v === "in" || v === "out" ? v : "unknown";
}

/** Any value outside the known region union is treated as absent, which itself fails closed (non-"us" ⇒
 *  opt-in-required region, per widget-memory/consent.ts). */
function asRegion(v: unknown): MemoryCtx["region"] {
  return v === "us" || v === "eu" || v === "uk" || v === "other" ? v : undefined;
}

/** Registers the OIDC-gated Pub/Sub push route for memory writes. Ack semantics: a valid delivery that
 *  writes ⇒ 204; a `remember` failure ⇒ 500 so Pub/Sub retries (then dead-letters, server-side); a
 *  malformed or subject-less message ⇒ 204 (ack + drop — retrying can never make it valid); bad/absent
 *  OIDC ⇒ 401. */
export function registerMemoryWritePushRoute(app: FastifyInstance, deps: MemoryWritePushDeps): void {
  registerOidcPushRoute(app, {
    routePath: MEMORY_PUSH_ROUTE,
    verify: deps.verify,
    expectedServiceAccount: deps.expectedServiceAccount,
    checkRateLimit: deps.checkRateLimit,
    handle: async (attributes, data) => {
      if (typeof data !== "string" || data.length === 0) return; // no body to write from — ack + drop

      let p: MemoryWritePayload;
      try {
        p = JSON.parse(data) as MemoryWritePayload;
      } catch {
        return; // malformed JSON — ack + drop, retrying can't fix a bad body
      }

      // There is no safe default write: a subject-less or incomplete turn can never be attributed or
      // written correctly, so it is dropped rather than guessed at.
      if (!isNonBlankString(p.tenantId) || !isNonBlankString(p.anonId) || !isNonBlankString(p.message) || !isNonBlankString(p.reply)) {
        return;
      }

      const id = typeof attributes.id === "string" ? attributes.id : undefined;
      // §E1 (security-review LOW-1) — fail CLOSED on a missing/invalid publishedAt: treat it as 0 (the
      // oldest possible publish time) so ANY existing tombstone (0 <= erasedAtMs) still drops the message.
      // Our publishers always set it and the OIDC gate limits the sender to our own backend, but for an
      // erasure control the safe direction is to still consult the tombstone, never to bypass it.
      const publishedAt = typeof p.publishedAt === "number" ? p.publishedAt : 0;

      // §E1 — erasure tombstone: a withdrawal/erasure request that lands AFTER this message was
      // published but BEFORE it is delivered must still win — ack + drop rather than write a fact the
      // shopper already asked to have forgotten.
      if (deps.wasErasedAfter && (await deps.wasErasedAfter(p.tenantId, p.anonId, publishedAt))) {
        return;
      }

      // §E2 — consume-side idempotency dedup: a redelivery of an already-written message is ack + dropped
      // rather than re-running the distiller call.
      if (deps.alreadyProcessed && id && (await deps.alreadyProcessed(p.tenantId, id))) {
        return;
      }

      const ctx: MemoryCtx = {
        tenantId: p.tenantId,
        anonId: p.anonId,
        region: asRegion(p.region),
        consent1: asConsent(p.consent1),
        consent2: asConsent(p.consent2),
      };
      const turn: MemoryTurn = { message: p.message, reply: p.reply };

      // A throw propagates so the core returns 500 (Pub/Sub retries, then dead-letters) — and, critically,
      // is never marked processed below, so the retry is not silently swallowed.
      await deps.remember(ctx, turn);

      // Mark-AFTER-success only: if this throws it does WITHOUT marking, exactly like `remember` throwing.
      if (deps.markProcessed && id) await deps.markProcessed(p.tenantId, id);
    },
  });
}
