import { InMemoryProposalStore, InMemoryRuntimeStore } from "@palup/platform-ports";
import { proposalStoreContract } from "@palup/platform-ports/contract/proposal-store";

// `ProposalStore`/`InMemoryProposalStore` live in `@palup/platform-ports` (moved there so
// `@palup/state-postgres`'s `PostgresProposalStore` can implement the port without a package cycle —
// see `packages/agent-runtime/src/index.ts`'s re-export note). This file proves the RE-EXPORT
// `@palup/agent-runtime` consumers rely on actually resolves and still passes the shared contract —
// not a duplicate of `packages/platform-ports/test/proposal-store.test.ts` (which is the port's own,
// canonical contract-conformance test), but the "agent-runtime's public surface still works" check.
proposalStoreContract(() => new InMemoryProposalStore(new InMemoryRuntimeStore()));
