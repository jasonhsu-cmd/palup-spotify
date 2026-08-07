import { runQueuePortContract } from "../src/contract/queue-port.contract.js";
import { createInMemoryQueue } from "../src/queue-port.js";

// The in-memory reference is the behavioral oracle; the Cloud Tasks / Pub/Sub adapters (built at A3
// deploy time) will run the SAME contract so the backbone stays swappable (ADR-0001 / ADR-0006).
runQueuePortContract(() => createInMemoryQueue({ maxAttempts: 3 }));
