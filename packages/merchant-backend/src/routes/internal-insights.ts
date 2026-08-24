import type { FastifyInstance } from "fastify";
import { requirePermission } from "@palup/identity-shopify";
import type { InsightCandidate, LearnedStore } from "@palup/platform-ports";
import { classifyFact } from "@palup/widget-memory";
import { synthesizeInsights, INSIGHT_SYNTHESIZER_AGENT_ID } from "@palup/agent-runtime";
import { randomUUID } from "node:crypto";

// W3 Task 5: `POST /_internal/run-insights` — a STAGING TRIGGER for the insight synthesizer, so staging
// can exercise gather->grade->record end-to-end for the caller's own tenant. // staging trigger; replaced
// by the scheduled runtime host (later plan). ctx from `req.principal.merchantId` ONLY. Records only
// grounded insights; drops the rest honestly (INCLUDING every `category:"voice"` candidate — B1, see
// `insight-synthesizer.ts`'s header: the merchant owns voice, this agent never silently records/alters
// it, no matter how well-grounded the candidate is). A candidate whose text classifies special-category
// (`classifyFact`) is FLAGGED in the audit; surfacing it in prod stays memory-legal-gated (ADR-0015).
//
// Candidate SOURCE: for this staging trigger the candidates arrive in the request body (a real scheduled
// host will gather them from orders/chats/outcomes). An empty/sub-floor gather records NOTHING — the
// console then shows an honest "still measuring" empty state, never a fabricated insight.

export interface RunInsightsDeps { learnedStore: LearnedStore }

interface RunInsightsBody { candidates?: InsightCandidate[] }

export function registerInternalInsightsRoutes(app: FastifyInstance, deps: RunInsightsDeps): void {
  app.post<{ Body: RunInsightsBody }>("/_internal/run-insights", { preHandler: requirePermission("agent.operate") }, async (req) => {
    const ctx = { tenantId: req.principal!.merchantId };
    const candidates = Array.isArray(req.body?.candidates) ? req.body!.candidates : [];
    const now = new Date().toISOString();
    const { recorded, dropped } = synthesizeInsights({ candidates, now, newId: randomUUID, tenantId: ctx.tenantId });
    const flaggedSpecial: string[] = [];
    for (const insight of recorded) {
      if (classifyFact(insight.text).class === "special") flaggedSpecial.push(insight.id); // memory-legal-gated for prod
      await deps.learnedStore.record(ctx, insight, INSIGHT_SYNTHESIZER_AGENT_ID);
    }
    return { recorded: recorded.length, dropped: dropped.length, flaggedSpecial };
  });
}
