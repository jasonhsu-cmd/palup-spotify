import { runProductFactsPortContract } from "../src/contract/product-facts-port.contract.js";
import { createInMemoryProductFactsStore } from "../src/product-facts-port.js";

// The in-memory reference adapter is the behavioral oracle; the Postgres adapter runs the SAME contract
// (packages/state-postgres/test/postgres-product-facts-store.test.ts) so the engine stays swappable.
runProductFactsPortContract(() => createInMemoryProductFactsStore());
