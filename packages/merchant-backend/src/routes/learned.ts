import type { FastifyInstance } from "fastify";
import { requirePermission } from "@palup/identity-shopify";
import {
  LearnedInsightNotFoundError, isSafetyFloorViolation,
  type LearnedCategory, type LearnedInsight, type LearnedStore, type TeachingStance,
} from "@palup/platform-ports";
import { randomUUID } from "node:crypto";

// W3 Task 4: the merchant-facing Learned surface. Every route derives ctx from `req.principal.merchantId`
// ONLY (never a body/query/header) — same tenant-isolation guarantee as /rules and /audit. GET is
// `console.view` (every role reads their own brain); teach/pin/delete are `learned.edit` (manager+). The
// aggregate tier is NEVER served here — GET only ever returns the private layer (the hard wall is in the
// store; this route never even asks for `tier:"aggregate"`).

export interface LearnedRoutesDeps { learnedStore: LearnedStore }

/** Merchant-safe DTO (audit.ts discipline): a fixed field set, never the raw stored object, so a future
 *  field added to `LearnedInsight` can't leak through an accidental pass-through. */
export interface SafeLearnedInsight {
  id: string; category: LearnedCategory; tier: LearnedInsight["tier"]; origin: LearnedInsight["origin"];
  text: string; source: string; sampleSize: number; confidence: LearnedInsight["grounding"]["confidence"];
  pinned: boolean; createdAt: string; updatedAt: string;
}
function toSafe(i: LearnedInsight): SafeLearnedInsight {
  return { id: i.id, category: i.category, tier: i.tier, origin: i.origin, text: i.text,
    source: i.grounding.source, sampleSize: i.grounding.sampleSize, confidence: i.grounding.confidence,
    pinned: i.pinned, createdAt: i.createdAt, updatedAt: i.updatedAt };
}

const VALID_CATEGORIES: ReadonlySet<string> = new Set<LearnedCategory>(["customers", "products", "voice", "policies"]);

interface TeachBody { category?: unknown; text?: unknown; guardrailKey?: unknown; stance?: unknown }
interface PinBody { pinned?: unknown }

export function registerLearnedRoutes(app: FastifyInstance, deps: LearnedRoutesDeps): void {
  app.get<{ Querystring: { category?: string } }>("/learned", { preHandler: requirePermission("console.view") }, async (req) => {
    const ctx = { tenantId: req.principal!.merchantId };
    const category = req.query.category;
    const filter = category && VALID_CATEGORIES.has(category) ? { category: category as LearnedCategory } : undefined;
    const items = await deps.learnedStore.list(ctx, filter);
    return { items: items.map(toSafe) };
  });

  app.post<{ Body: TeachBody }>("/learned", { preHandler: requirePermission("learned.edit") }, async (req, reply) => {
    const ctx = { tenantId: req.principal!.merchantId };
    const { category, text, guardrailKey, stance } = req.body ?? {};
    if (typeof category !== "string" || !VALID_CATEGORIES.has(category)) return reply.code(400).send({ error: "invalid category" });
    if (typeof text !== "string" || !text.trim()) return reply.code(400).send({ error: "text is required" });
    // Safety floor (spec §10): a policy teaching may TIGHTEN a safety-critical guardrail but never loosen it.
    if (category === "policies" && typeof guardrailKey === "string" && (stance === "tighten" || stance === "loosen")) {
      if (isSafetyFloorViolation(guardrailKey, stance as TeachingStance)) {
        return reply.code(400).send({ error: "safety floor: a safety-critical guardrail can be tightened but not loosened" });
      }
    }
    const at = new Date().toISOString();
    // Merchant teaching is AUTHORITATIVE per-tenant config (not a statistical insight) — confidence "high",
    // sampleSize 0 by convention (it did not come from an observation count). It is NOT graded by
    // `gradeInsight` (that gate is for SYNTHESIZED insights, Task 5).
    const insight: LearnedInsight = {
      id: randomUUID(), tenantId: ctx.tenantId, category: category as LearnedCategory, tier: "private",
      origin: "merchant_taught", text: text.trim(),
      grounding: { source: "merchant_taught", sampleSize: 0, confidence: "high" },
      pinned: false, createdAt: at, updatedAt: at,
    };
    await deps.learnedStore.record(ctx, insight, req.principal!.userId);
    return { insight: toSafe(insight) };
  });

  app.post<{ Params: { id: string }; Body: PinBody }>("/learned/:id/pin", { preHandler: requirePermission("learned.edit") }, async (req, reply) => {
    const ctx = { tenantId: req.principal!.merchantId };
    const pinned = req.body?.pinned;
    if (typeof pinned !== "boolean") return reply.code(400).send({ error: "pinned (boolean) is required" });
    try {
      const next = await deps.learnedStore.setPinned(ctx, req.params.id, pinned, req.principal!.userId, new Date().toISOString());
      return toSafe(next);
    } catch (e) {
      if (e instanceof LearnedInsightNotFoundError) return reply.code(404).send({ error: "not found" });
      throw e;
    }
  });

  app.delete<{ Params: { id: string } }>("/learned/:id", { preHandler: requirePermission("learned.edit") }, async (req, reply) => {
    const ctx = { tenantId: req.principal!.merchantId };
    try {
      await deps.learnedStore.remove(ctx, req.params.id, req.principal!.userId, new Date().toISOString());
      return { removed: true };
    } catch (e) {
      if (e instanceof LearnedInsightNotFoundError) return reply.code(404).send({ error: "not found" });
      throw e;
    }
  });

  // Export the merchant's own private brain ("you own your agent's brain"). The READ mechanism is real; the
  // portability/format GUARANTEE + delivery is legal-deferred (spec §10), stated honestly in the payload.
  app.get("/learned/export", { preHandler: requirePermission("console.view") }, async (req) => {
    const ctx = { tenantId: req.principal!.merchantId };
    const insights = (await deps.learnedStore.list(ctx)).map(toSafe);
    return {
      tenantId: ctx.tenantId, exportedAt: new Date().toISOString(), insights,
      portabilityNote: "You own your agent's private brain. A signed, portable export format is pending legal review; this is the raw private layer as currently stored.",
    };
  });
}
