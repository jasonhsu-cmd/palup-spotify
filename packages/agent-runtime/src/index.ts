// The proposal domain model + ProposalStore port live in `@palup/platform-ports` (moved there so
// `@palup/state-postgres`'s `PostgresProposalStore` can implement the port without a package cycle —
// `agent-runtime` already depends on `state-postgres` for the shared kill registry, `kill.ts`).
// Re-exported here so every existing `@palup/agent-runtime` import keeps resolving unchanged.
export {
  ttlForCategory,
  VersionConflictError,
  ProposalNotFoundError,
  InMemoryProposalStore,
  type Proposal,
  type ProposalCategory,
  type ProposalStatus,
  type AgentAction,
  type BoundaryReason,
  type ReversalPlan,
  type ProposalStore,
  type ProposalListFilter,
  type ProposalListResult,
  type ProposalTransitionPatch,
} from "@palup/platform-ports";
export * from "./classify.js";
export * from "./kill.js";
export * from "./loop.js";
// WB win-back agent (task 5, merchant-backend's staging trigger route): no external caller existed
// before this, so these were never re-exported. Named exports (not `export *`) so this module's own
// internal helpers (`requireRecipients`/`requireString`) stay unexported.
export {
  findLapsedSegment,
  draftWinBack,
  proposeWinBack,
  campaignExecutor,
  type FindLapsedSegmentOpts,
  type WinBackDraft,
  type ProposeWinBackInput,
} from "./agents/win-back.js";
// W3 Task 5: the insight-synthesizer producer (staging trigger lives in merchant-backend) — named
// exports (not `export *`) mirroring the win-back re-export just above, for the same reason.
export {
  synthesizeInsights,
  INSIGHT_SYNTHESIZER_AGENT_ID,
  type SynthesisInput,
  type SynthesisResult,
} from "./insight-synthesizer.js";
// W3 Task 6: agent-proposes / merchant-owns voice — named exports (not `export *`), same reason as
// win-back/insight-synthesizer above.
export {
  proposeVoiceChange,
  voiceChangeExecutor,
  VOICE_AGENT_TYPE,
  type ProposeVoiceChangeInput,
} from "./voice.js";
// W4-broaden Task 7: agent-proposed rule changes route through W1 — named exports (not `export *`),
// same reason as win-back/insight-synthesizer/voice above.
export {
  RULE_CHANGE_ACTION_TYPE,
  buildRuleChangeAction,
  applyRuleChangeFromProposal,
} from "./rule-change-proposal.js";
// W4-min: `MerchantRulesStore`/`CONSERVATIVE_DEFAULTS`/`PALUP_FLOORS`/etc. are DEFINED in
// `@palup/platform-ports` (moved there, task 5 — see `rules.ts`'s header) and re-exported by
// `rules.ts`; `createRulesProvider` stays defined here. `export *` surfaces both together so a
// future `@palup/agent-runtime` consumer (e.g. `merchant-backend`'s `GET/PUT /rules`, task 4) can
// import everything from one place, exactly like `ProposalStore`'s re-export via this same file.
export * from "./rules.js";
// W5 Task 7: the refund executor — agent-proposed/human-approved refunds route through W1 — named
// exports (not `export *`), same reason as win-back/insight-synthesizer/voice above. Dark: nothing
// wires this into the live registry yet (Task 8).
export { refundExecutor, REFUND_ACTION_TYPE, REFUND_AGENT_TYPE } from "./refund.js";
