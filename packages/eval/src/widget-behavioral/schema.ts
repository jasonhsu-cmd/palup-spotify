// Layer-1 widget-behavioral case schema. This package's later tasks (loader validation
// hardening, runner, grounding stub, brain-config wiring, main.ts CLI) all import these types
// from here — keep them the single source of truth, no shadow copies.

import type { GroundingStubConfig } from "./grounding-stub.js";
export type { GroundingStubConfig } from "./grounding-stub.js";

/** Per-turn / single-turn expectation asserted against the brain's Decision + assistant reply. */
export type Expect = {
  mode?: "safety" | "support" | "sales" | "smalltalk";
  pitchIs?: string; // exact PitchKind, e.g. "replenishment"; "none" allowed
  pitched?: boolean; // pitch !== "none"
  escalate?: boolean;
  outbound?: boolean;
  flags?: string[]; // all must be present in Decision.flags
  must?: string[]; // holds() tokens (contains:/mode_*/pitched/escalate/raw-flag)
  mustNot?: string[];
};

/** End-of-session invariants for multi-turn (`turns`) cases. */
export type SessionInvariants = {
  safetyLatched?: boolean;
  openIssuesEmpty?: boolean; // state.openIssues.length === 0
  pitchesUsedAtMost?: number; // state.pitchesUsed <= n (INV-E budget)
};

/**
 * Maps to createBrain's positional flags; all optional. `stub` (GroundingStubConfig, Task 5) is
 * only meaningful when grounding === "stub".
 */
export type BrainConfig = {
  grounding?: "static" | "stub";
  subscriptionSelfServe?: boolean;
  dispositionStyle?: boolean;
  dispositionBehavioral?: boolean;
  dispositionClassifier?: boolean;
  catalogRetrievalEnabled?: boolean;
  productCitationsEnabled?: boolean;
  productCardsEnabled?: boolean;
  cartLineItemsEnabled?: boolean;
  stub?: GroundingStubConfig;
};

export type BehavioralCase = {
  id: string;
  family: string; // e.g. "safety" | "grounding-integrity" | "support" | ...
  severity: "P0" | "P1" | "P2" | "P3" | "observation";
  riskClass: string; // §7 risk_class value
  signals: Record<string, unknown>;
  brain?: BrainConfig;
  message?: string; // single-turn
  turns?: string[]; // multi-turn (mutually exclusive with message)
  expect?: Expect; // single-turn expectation (or last-turn for arcs)
  perTurnExpect?: Expect[]; // optional per-turn expectations for arcs
  session?: SessionInvariants; // multi-turn end-state invariants
};
