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

/**
 * Coverage self-check annotation (Task 11+ gap-closure) — declares which message-derived enum
 * value(s) this case was AUTHORED to exercise. Unlike `signals` (server/caller-supplied fields the
 * coverage test can read directly off the case), SupportIntent/SafetyClass/PersonaRole are derived
 * from the free-text `message` by the brain's own classifiers, so there is no signal key to scan for
 * them — `covers` is the declared intent, and `coverage.test.ts` independently RE-DERIVES each
 * annotated value (via `classifySupportIntent` / a live `brain.decide()` call) to confirm the
 * annotation is honest rather than aspirational.
 */
export type Covers = {
  supportIntent?: string; // one of widget-brain's SUPPORT_INTENTS
  safetyClass?: string; // one of widget-brain's SafetyClass values
  personaRole?: string; // one of widget-brain's PersonaRole values
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
  covers?: Covers; // declared message-derived enum coverage, verified by coverage.test.ts
};
