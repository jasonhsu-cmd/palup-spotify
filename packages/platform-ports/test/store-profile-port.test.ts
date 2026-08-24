import { runStoreProfilePortContract } from "../src/contract/store-profile-port.contract.js";
import { createInMemoryStoreProfileStore } from "../src/store-profile-port.js";

// The in-memory reference adapter is the behavioral oracle; the Postgres adapter runs the SAME contract
// (packages/state-postgres/test/postgres-store-profile-store.test.ts) so the engine stays swappable.
runStoreProfilePortContract(() => createInMemoryStoreProfileStore());
