import { runModelPortContract } from "@palup/platform-ports/contract";
import { MockModelAdapter } from "../src/index.js";

// The mock adapter must satisfy the same port contract every adapter does (ADR-0001).
runModelPortContract(() => new MockModelAdapter());
