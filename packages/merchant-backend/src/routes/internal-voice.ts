import type { FastifyInstance } from "fastify";
import { requirePermission } from "@palup/identity-shopify";
import type { LearnedStore, MerchantRulesStore, ProposalStore, RuntimeStatePort } from "@palup/platform-ports";
import { createRulesProvider, proposeVoiceChange, voiceChangeExecutor } from "@palup/agent-runtime";
import type { EngineDeps } from "@palup/agent-runtime";
import { randomUUID } from "node:crypto";

export interface ProposeVoiceDeps {
  /** Passed to `EngineDeps.state` (kill-switch check + audit) — same convention as
   *  `internal-winback.ts`/`internal-insights.ts`. */
  state: RuntimeStatePort;
  proposalStore: ProposalStore;
  rulesStore: MerchantRulesStore;
  /** The executor `voiceChangeExecutor` wraps is wired here ONLY so this route's own `EngineDeps`
   *  shape-checks — `proposeVoiceChange` never calls it: `classifyAction` re-derives `autonomy_scope`
   *  for the unmapped `change_voice` action type (never auto-eligible), so `proposeOrExecute` always
   *  takes the pending-proposal branch and never reaches `deps.executor` here. The insight is written
   *  ONLY when a human later approves via `POST /approvals/:id/approve`, which resolves its OWN
   *  `voiceChangeExecutor` through `engine-wiring.ts`'s registry (`resolveExecutor("change_voice", ...)`)
   *  — a SEPARATE call, not this route's `engineDeps`. */
  learnedStore: LearnedStore;
}

interface ProposeVoiceBody {
  proposedVoiceText?: string;
  rationale?: string;
}

/**
 * `POST /_internal/propose-voice` — a STAGING TRIGGER letting the agent PROPOSE a voice/tone change
 * for the caller's own tenant (W3 Task 6 — "merchant owns voice"). Registered inside server.ts's
 * authenticated `merchantPlane` context (F3), so `requireMerchant` already 401-gated an absent/invalid
 * bearer before reaching this handler; `requirePermission("agent.operate")` additionally 403s a bare
 * `viewer`.
 *
 * Always lands exactly one PENDING `autonomy_scope` `Proposal` via `proposeVoiceChange` ->
 * `proposeOrExecute` and writes NOTHING to the Learned store — `autonomy_scope` is never auto-eligible
 * (`AUTO_ELIGIBLE_DIMENSIONS.autonomy_scope = []`, `PALUP_FLOORS.autonomy_scope.maxAutoPct = 0`), and
 * `change_voice` is also an unmapped action type in `classify.ts`, so the category is independently
 * re-derived as `autonomy_scope` from the action itself — doubly, not singly, forced into the pending
 * path. The voice insight is written ONLY when a human later approves the proposal
 * (`POST /approvals/:id/approve`, which resolves `change_voice` -> `voiceChangeExecutor` via
 * `engine-wiring.ts`) — see the `Approval Center` UI, never here.
 *
 * `ctx` is derived from `req.principal.merchantId` ONLY — never the request body — so a caller can
 * never propose a voice change for a tenant other than their own.
 *
 * // staging trigger; replaced by the scheduled runtime host (later plan), mirroring
 * // `internal-winback.ts`/`internal-insights.ts`.
 */
export function registerInternalVoiceRoutes(app: FastifyInstance, deps: ProposeVoiceDeps): void {
  app.post<{ Body: ProposeVoiceBody }>(
    "/_internal/propose-voice",
    { preHandler: requirePermission("agent.operate") },
    async (req, reply) => {
      const principal = req.principal!; // set by the enclosing requireMerchant preHandler
      const ctx = { tenantId: principal.merchantId };
      const now = new Date().toISOString();

      const proposedVoiceText = typeof req.body?.proposedVoiceText === "string" ? req.body.proposedVoiceText.trim() : "";
      if (!proposedVoiceText) {
        return reply.code(400).send({ error: "proposedVoiceText is required" });
      }
      const rationale =
        typeof req.body?.rationale === "string" && req.body.rationale.trim()
          ? req.body.rationale.trim()
          : "agent-proposed voice change";

      const engineDeps: EngineDeps = {
        store: deps.proposalStore,
        state: deps.state,
        rules: createRulesProvider(deps.rulesStore),
        executor: voiceChangeExecutor(deps.learnedStore, randomUUID, () => new Date().toISOString()),
        validate: async () => ({ valid: true }),
      };

      const result = await proposeVoiceChange({ ctx, now, proposedVoiceText, rationale }, engineDeps);
      if (!result.proposal) {
        // proposeVoiceChange throws if the loop ever reports "executed" for a voice change — a
        // "proposed" kind with no proposal attached would be an internal contract violation, not a
        // case to 200 through.
        return reply.code(500).send({ error: "voice-change proposal creation failed" });
      }
      return { proposedId: result.proposal.id };
    },
  );
}
