// Public surface of @palup/widget-memory (ADR-0015 PR A — T1-T7). Nothing here is imported by any
// serving code yet: the package is provably inert (flag.ts's double gate) until a later, separately
// governed PR wires it into /chat and flips MEMORY_ADR_ACCEPTED.

export { MEMORY_ADR_ACCEPTED, isMemoryEnabled } from "./flag.js";

export { generateGuestId, subjectNamespace, validateAnonId } from "./identity.js";

export type { MemoryConsent, ConsentInputs, WriteCapability, Region } from "./consent.js";
export { decideMemoryWrite } from "./consent.js";

export type { FactClass, FactClassification, TenantSensitivityPolicy } from "./classifier.js";
export { classifyFact } from "./classifier.js";

export type { FactDistiller } from "./distiller.js";
export { createStubDistiller, sanitizeFact, FACT_MAX_CHARS } from "./distiller.js";

export type { MemoryAction } from "./audit.js";
export { buildMemoryAudit } from "./audit.js";

export type { MemoryCtx, MemoryTurn, RecalledFact, MemoryService } from "./types.js";

export { createMemoryService } from "./service.js";
export type { MemoryServiceDeps } from "./service.js";
