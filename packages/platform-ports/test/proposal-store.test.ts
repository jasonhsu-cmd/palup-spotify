import { InMemoryRuntimeStore } from "../src/in-memory-runtime-store.js";
import { InMemoryProposalStore } from "../src/proposal-store.js";
import { proposalStoreContract } from "../src/contract/proposal-store.contract.js";

// The in-memory adapter is the behavioral oracle for the port: it must pass the full contract (the
// Postgres adapter, `@palup/state-postgres`'s `PostgresProposalStore`, runs the SAME suite — that is
// the point of the contract-test convention, e.g. `runMerchantRegistryPortContract`).
proposalStoreContract(() => new InMemoryProposalStore(new InMemoryRuntimeStore()));
