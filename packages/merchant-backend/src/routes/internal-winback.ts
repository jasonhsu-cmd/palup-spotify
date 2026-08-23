import type { FastifyInstance } from "fastify";
import { requirePermission } from "@palup/identity-shopify";
import type {
  CampaignCommsPort,
  CustomerListingCommerce,
  MerchantRulesStore,
  ProposalStore,
  RuntimeStatePort,
} from "@palup/platform-ports";
import { campaignExecutor, createRulesProvider, draftWinBack, findLapsedSegment, proposeWinBack } from "@palup/agent-runtime";
import type { EngineDeps } from "@palup/agent-runtime";

/** Default lapsed-customer window for the staging trigger — no per-request override yet (task 5's
 *  scope is "run the agent for the caller's tenant", not a merchant-configurable window; that is
 *  W4-min's `MerchantRulesStore`/rules-editor territory, not this route). */
const DEFAULT_LAPSED_DAYS = 60;

export interface RunWinBackDeps {
  /** The tenant-scoped runtime store — passed to `EngineDeps.state` (kill-switch check + audit). */
  state: RuntimeStatePort;
  commerce: CustomerListingCommerce;
  comms: CampaignCommsPort;
  proposalStore: ProposalStore;
  rulesStore: MerchantRulesStore;
}

/**
 * `POST /_internal/run-winback` — a STAGING TRIGGER for the win-back agent (WB), so staging can
 * exercise the full findLapsedSegment -> draftWinBack -> proposeWinBack pipeline end-to-end for a
 * real caller's own tenant. Registered inside server.ts's authenticated `merchantPlane` context (F3),
 * so every call here already ran F2's `requireMerchant` (401 fail-closed) before reaching this
 * handler; the `requirePermission("agent.operate")` preHandler additionally 403s a bare `viewer`.
 *
 * // staging trigger; replaced by the scheduled runtime host (later plan)
 *
 * `ctx` is derived from `req.principal.merchantId` ONLY — never the request body — so a caller can
 * never trigger a run for a tenant other than their own. Always lands exactly one PENDING `campaign`
 * Proposal (via `proposeWinBack` -> `proposeOrExecute`) and sends NOTHING: `deps.comms` is a sandbox
 * (records, never delivers) on staging, and a `send_campaign` action can never auto-execute anyway
 * (agent-runtime's `AUTO_ELIGIBLE_DIMENSIONS.campaign = []` — `proposeWinBack` also throws
 * defensively if the loop ever reported "executed" for one).
 */
export function registerInternalWinBackRoutes(app: FastifyInstance, deps: RunWinBackDeps): void {
  app.post("/_internal/run-winback", { preHandler: requirePermission("agent.operate") }, async (req, reply) => {
    const principal = req.principal!; // set by the enclosing requireMerchant preHandler
    const ctx = { tenantId: principal.merchantId };
    const now = new Date().toISOString();

    const segment = await findLapsedSegment(deps.commerce, ctx, { lapsedDays: DEFAULT_LAPSED_DAYS, now });
    const draft = draftWinBack(segment, principal.merchantId);

    const engineDeps: EngineDeps = {
      store: deps.proposalStore,
      state: deps.state,
      rules: createRulesProvider(deps.rulesStore),
      executor: campaignExecutor(deps.comms),
      validate: async () => ({ valid: true }),
    };

    const result = await proposeWinBack({ segment, draft, ctx, now }, engineDeps);
    if (!result.proposal) {
      // proposeWinBack throws if the loop ever reports "executed" for a campaign — a "proposed" kind
      // with no proposal attached would be an internal contract violation, not a case to 200 through.
      return reply.code(500).send({ error: "win-back proposal creation failed" });
    }
    return { proposedId: result.proposal.id };
  });
}
