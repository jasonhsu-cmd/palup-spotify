import { runModelPortContract } from "../src/contract/model-port.contract.js";
import { fakeEmbeddingPort, completeOnlyPort } from "./fakes/fake-embedding-model.js";

// Runs the ModelPort contract down BOTH branches of the optional embed capability, so neither branch can
// rot unexercised:
//  - an embedding-capable adapter must satisfy every embed invariant (batch alignment, order, dimension,
//    fail-closed inputs, honest usage);
//  - a complete-only adapter must pass the suite UNCHANGED, with the embed block skipped and its absence
//    asserted (embed omitted, not a throwing stub).
// The fake is offline and deterministic — see the honesty note in test/fakes/fake-embedding-model.ts: this
// proves the contract's shape, not a real embedding service's behaviour.
runModelPortContract(() => fakeEmbeddingPort());
runModelPortContract(() => completeOnlyPort);
