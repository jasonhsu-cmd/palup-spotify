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
// W4-min: `MerchantRulesStore`/`CONSERVATIVE_DEFAULTS`/`PALUP_FLOORS`/etc. are DEFINED in
// `@palup/platform-ports` (moved there, task 5 — see `rules.ts`'s header) and re-exported by
// `rules.ts`; `createRulesProvider` stays defined here. `export *` surfaces both together so a
// future `@palup/agent-runtime` consumer (e.g. `merchant-backend`'s `GET/PUT /rules`, task 4) can
// import everything from one place, exactly like `ProposalStore`'s re-export via this same file.
export * from "./rules.js";
