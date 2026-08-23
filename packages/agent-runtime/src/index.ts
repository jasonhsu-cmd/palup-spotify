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
