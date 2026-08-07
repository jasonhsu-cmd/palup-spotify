export {
  createBrain,
  DEFAULT_CATALOG_RETRIEVAL_K,
  DEFAULT_POLICY,
  MONEY_GATED_PITCHES,
  normalizeHistory,
  HISTORY_MAX_TURNS,
  HISTORY_MAX_CHARS,
} from "./brain.js";
export type { Brain } from "./brain.js";
export {
  createSession,
  createMemorySessionStore,
} from "./session.js";
export type { Session, SessionState, SessionStore, SessionOptions } from "./session.js";
export { MockModelAdapter } from "./adapters/mock-model.js";
export { StaticGroundingAdapter } from "./adapters/static-grounding.js";
export { MockCommerceAdapter, demoCommerceGroundTruth } from "./adapters/mock-commerce.js";
export { consentPermits, consentPermitsFactClass } from "./consent-rules.js";
export type { ConsentRegion, ConsentTriState, ConsentTier } from "./consent-rules.js";
export { handleSupport, classifySupportIntent, extractOrderId } from "./support.js";
export { classifyOutgoingOffer, OFFER_CHECK_AGENT_TYPE } from "./offer-check.js";
export type { SupportIntent, SupportResult } from "./support.js";
export type * from "./types.js";
