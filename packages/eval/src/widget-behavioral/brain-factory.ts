import { createBrain, MockModelAdapter, StaticGroundingAdapter, type Brain } from "@palup/widget-brain";
import type { BrainConfig } from "./schema.js";

// Task 3 — brain factory. Arity/order verified against the REAL `createBrain` in
// packages/widget-brain/src/brain.ts:864-955 (16 positional params) — matches the brief's
// copy of packages/eval/src/candidates.ts:67-84 exactly, no drift.
//
// `cfg.grounding === "stub"` (Task 5 — StubGroundingAdapter over GroundingStubConfig) is not
// wired here; only "static" and absent are supported for now, same as the brief specifies.
export function makeBrain(cfg: BrainConfig = {}): Brain {
  const grounding = cfg.grounding === "static" ? new StaticGroundingAdapter() : undefined;
  return createBrain(
    new MockModelAdapter(),
    grounding,
    undefined, // policy -> DEFAULT_POLICY
    undefined, // commerce
    undefined, // shopperId -> default
    undefined, // memory (Task 5 for stub)
    cfg.subscriptionSelfServe ?? false,
    cfg.dispositionStyle ?? false,
    cfg.dispositionBehavioral ?? false,
    cfg.dispositionClassifier ?? false,
    undefined, // catalogRetriever (Task 5 for stub)
    cfg.catalogRetrievalEnabled ?? false,
    undefined, // catalogRetrievalK
    cfg.productCitationsEnabled ?? false,
    cfg.productCardsEnabled ?? false,
    cfg.cartLineItemsEnabled ?? false,
  );
}
