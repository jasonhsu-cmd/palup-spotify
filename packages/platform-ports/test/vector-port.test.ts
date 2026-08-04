import { runVectorPortContract } from "@palup/platform-ports/contract/vector";
import { createInMemoryVectorStore } from "../src/vector-port.js";

// The in-memory adapter is the behavioral oracle every VectorPort adapter (Postgres included — see
// packages/state-postgres/test/postgres-vector-store.test.ts) must reproduce exactly.
runVectorPortContract(() => createInMemoryVectorStore());
