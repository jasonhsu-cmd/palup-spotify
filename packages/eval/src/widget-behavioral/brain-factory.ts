import {
  createBrain,
  MockModelAdapter,
  StaticGroundingAdapter,
  type Brain,
  type MemoryRecallPort,
  type RecalledFact,
} from "@palup/widget-brain";
import type { BrainConfig } from "./schema.js";
import { makeStubGrounding } from "./grounding-stub.js";

// Task 3 — brain factory. Arity/order verified against the REAL `createBrain` in
// packages/widget-brain/src/brain.ts:864-955 (16 positional params) — matches the brief's
// copy of packages/eval/src/candidates.ts:67-84 exactly, no drift.
//
// Task 5 — `cfg.grounding === "stub"` wires `makeStubGrounding(cfg.stub)` into the grounding
// slot; when `cfg.stub.memoryFacts` is also set, a matching inline `MemoryRecallPort` stub is
// wired into the memory slot (position 6). `class` is left unset for an "ordinary" fact and set
// to exactly `"special"` for a "special" one — the one string `consentPermitsFactClass`
// (widget-brain/src/consent-rules.ts) branches on; anything else collapses to ordinary.
export function makeBrain(cfg: BrainConfig = {}): Brain {
  const grounding =
    cfg.grounding === "static"
      ? new StaticGroundingAdapter()
      : cfg.grounding === "stub"
        ? makeStubGrounding(cfg.stub ?? {})
        : undefined;

  const memoryFacts = cfg.grounding === "stub" ? cfg.stub?.memoryFacts : undefined;
  const memory: MemoryRecallPort | undefined = memoryFacts
    ? {
        async recall(): Promise<RecalledFact[]> {
          return memoryFacts.map((f) => ({
            text: f.text,
            ...(f.tier === "special" ? { class: "special" } : {}),
          }));
        },
      }
    : undefined;

  return createBrain(
    new MockModelAdapter(),
    grounding,
    undefined, // policy -> DEFAULT_POLICY
    undefined, // commerce
    undefined, // shopperId -> default
    memory,
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
