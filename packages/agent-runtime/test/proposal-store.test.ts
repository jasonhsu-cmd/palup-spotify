import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { InMemoryProposalStore } from "../src/proposal-store.js";
import { proposalStoreContract } from "../src/contract/proposal-store.contract.js";

// The in-memory adapter runs the SAME shared contract the Postgres adapter (Task 8,
// packages/state-postgres/test/proposal-store.test.ts) runs — proven parity, not assumed.
proposalStoreContract(() => new InMemoryProposalStore(new InMemoryRuntimeStore()));
