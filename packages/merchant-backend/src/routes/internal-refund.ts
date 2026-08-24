import type { FastifyInstance } from "fastify";
import { requirePermission } from "@palup/identity-shopify";
import type { MerchantRulesStore, ProposalStore, RefundPort, RuntimeStatePort } from "@palup/platform-ports";
import { createRulesProvider, proposeOrExecute, refundExecutor, REFUND_ACTION_TYPE, REFUND_AGENT_TYPE, type EngineDeps } from "@palup/agent-runtime";

// W5 Task 9 — `POST /_internal/propose-refund`: a STAGING TRIGGER that runs one candidate refund
// through the W1 loop (`proposeOrExecute`), proving the propose-only + tiny-goodwill behavior against
// the REAL `PALUP_FLOORS.refund` + merchant rules (via `createRulesProvider`) — NO governance/classifier
// logic is touched here; the propose-vs-auto split comes entirely from the existing classifier reading
// `PALUP_FLOORS.refund`/`AUTO_ELIGIBLE_DIMENSIONS.refund`. Registered inside server.ts's authenticated
// `merchantPlane` (F3) so `requireMerchant` (401) already ran before this handler; `agent.operate`
// additionally 403s a bare viewer. `ctx` is `req.principal.merchantId` ONLY — never the request body —
// so a caller can never trigger a refund proposal/auto-act for a tenant other than their own.
//
// `agentType` is the dedicated `REFUND_AGENT_TYPE` ("refund_desk"), never a shared "service"/"win_back"
// type (refund.ts's own doc comment: this lets an operator arm a TYPE-SCOPED kill on just the one
// money-moving agent without halting every other automation). The executor is `refundExecutor(deps.
// refundPort)` — on staging that's the `SandboxRefundAdapter` (records an intent, never contacts a real
// gateway); a live adapter is a separate, human-gated enablement (DEPLOY docs), not something this route
// decides.
//
// staging trigger; replaced by the scheduled runtime host (later plan)

export interface ProposeRefundDeps {
  state: RuntimeStatePort;
  proposalStore: ProposalStore;
  rulesStore: MerchantRulesStore;
  refundPort: RefundPort;
}

interface ProposeRefundBody {
  orderRef?: unknown;
  amountUsd?: unknown;
  reason?: unknown;
}

export function registerInternalRefundRoutes(app: FastifyInstance, deps: ProposeRefundDeps): void {
  app.post<{ Body: ProposeRefundBody }>(
    "/_internal/propose-refund",
    { preHandler: requirePermission("agent.operate") },
    async (req, reply) => {
      const principal = req.principal!; // set by the enclosing requireMerchant preHandler
      const ctx = { tenantId: principal.merchantId };
      const now = new Date().toISOString();

      const { orderRef, amountUsd, reason } = req.body ?? {};
      if (typeof orderRef !== "string" || orderRef.length === 0 || typeof amountUsd !== "number" || !Number.isFinite(amountUsd)) {
        return reply.code(400).send({ error: "orderRef (string) and amountUsd (number) are required" });
      }
      const reasonStr = typeof reason === "string" && reason.length > 0 ? reason : "goodwill";

      const engineDeps: EngineDeps = {
        store: deps.proposalStore,
        state: deps.state,
        rules: createRulesProvider(deps.rulesStore),
        executor: refundExecutor(deps.refundPort),
        validate: async () => ({ valid: true }),
      };

      const result = await proposeOrExecute(
        {
          ctx,
          agentId: `agent:${principal.merchantId}:refund`,
          agentType: REFUND_AGENT_TYPE,
          category: "refund",
          rationale: `Refund $${amountUsd} on order ${orderRef} (${reasonStr})`,
          reversalPlan: { reversible: true, plan: "Re-charge the customer via Shopify admin if issued in error." },
          now,
          action: { type: REFUND_ACTION_TYPE, params: { orderRef, usd: amountUsd, reason: reasonStr } },
        },
        engineDeps,
      );

      return result.kind === "executed"
        ? { kind: "executed" as const }
        : { kind: "proposed" as const, proposedId: result.proposal!.id };
    },
  );
}
