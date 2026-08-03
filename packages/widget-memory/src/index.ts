// Public surface of @palup/widget-memory (ADR-0015 PR A — T1-T7). Nothing here is imported by any
// serving code yet: the package is provably inert (flag.ts's double gate) until a later, separately
// governed PR wires it into /chat and flips MEMORY_ADR_ACCEPTED.

export { MEMORY_ADR_ACCEPTED, isMemoryEnabled } from "./flag.js";

export { generateGuestId, subjectNamespace, validateAnonId } from "./identity.js";

export type { MemoryConsent, ConsentInputs, WriteCapability, Region } from "./consent.js";
export { decideMemoryWrite } from "./consent.js";

export type { FactClass, FactClassification, TenantSensitivityPolicy } from "./classifier.js";
export { classifyFact } from "./classifier.js";

export type { Disposition, DispositionAxis } from "./disposition.js";

export type { FactDistiller, DistilledCandidate, ModelDistillerDeps } from "./distiller.js";
export { createStubDistiller, createModelDistiller, sanitizeFact, isValidDisposition, FACT_MAX_CHARS } from "./distiller.js";

export type { MemoryAction } from "./audit.js";
export { buildMemoryAudit } from "./audit.js";

export type { MemoryCtx, MemoryTurn, RecalledFact, MemoryService } from "./types.js";

export { createMemoryService } from "./service.js";
export type { MemoryServiceDeps } from "./service.js";

// T8-T10 (ADR-0015 PR B — retention/TTL, erasure/consent-withdrawal, account merge). Same inertness
// contract as PR A: nothing here is wired into any serving code path yet, and every handler only ever
// touches the vector port the caller hands it — no call to any of these functions happens unless a
// later, separately-gated PR invokes them behind `isMemoryEnabled()`.
export { ORDINARY_TTL_DAYS, SPECIAL_TTL_DAYS, ttlForClass, sweepExpired } from "./retention.js";
export type { RetentionDeps } from "./retention.js";

export { eraseSubject, withdrawConsent1, withdrawConsent2, eraseTenant } from "./erasure.js";
export type { ErasureDeps, SubjectRef } from "./erasure.js";

export { mergeGuestIntoAccount } from "./merge.js";
export type { MergeDeps, MergeCtx } from "./merge.js";
