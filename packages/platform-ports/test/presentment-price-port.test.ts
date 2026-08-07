import { runPresentmentPricePortContract } from "../src/contract/presentment-price-port.contract.js";
import { createInMemoryPresentmentPriceStore } from "../src/presentment-price-port.js";

// The in-memory reference adapter is the behavioral oracle; the Postgres adapter runs the SAME contract
// (packages/state-postgres/test/postgres-presentment-price-store.test.ts) so the engine stays swappable.
runPresentmentPricePortContract(() => createInMemoryPresentmentPriceStore());
