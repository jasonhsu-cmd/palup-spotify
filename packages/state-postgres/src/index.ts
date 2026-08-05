export { PostgresRuntimeStore } from "./postgres-runtime-store.js";
export { PostgresVectorStore } from "./postgres-vector-store.js";
// B1 adapter. Exported so C1's OAuth routes can wire it; NOTHING imports it yet (see the file header).
export {
  PostgresMerchantRegistry,
  type PostgresMerchantRegistryOpts,
} from "./postgres-merchant-registry.js";
// B2 store. Exported so C1's OAuth routes can wire it; NOTHING imports it yet (see the file header).
export {
  createMerchantCredentialStore,
  MERCHANT_CRED_KEY_SCOPE,
  MERCHANT_CRED_COLLECTION,
  MERCHANT_CRED_RECORD_KEY,
  type MerchantCredentialStore,
  type MerchantCredentialStoreOpts,
  type MerchantCredentialRead,
} from "./merchant-credential-store.js";
export { PgPoolSql, pgPoolSqlFromUrl, type Sql } from "./sql.js";
export { createRuntimeStore } from "./factory.js";
export { createVectorStore } from "./vector-factory.js";
export {
  matchedKill,
  armKill,
  disarmKill,
  killStatus,
  RUNTIME_AGENT_TYPE,
  type KillScope,
  type KillEntry,
} from "./runtime-kill-registry.js";
export {
  matchedCostCap,
  setCostCap,
  clearCostCap,
  costCapStatus,
  type CostCapScope,
  type CostCapEntry,
} from "./cost-cap-registry.js";
export {
  readOrchestratorState,
  recordAutoPromotion,
  recordAutoPromotionTx,
  freezeAutoPromote,
  freezeAutoPromoteTx,
  rateLimitReason,
  AUTO_PROMOTE_WINDOW_MS,
  type OrchestratorState,
} from "./orchestrator-registry.js";
export {
  readAutoStage,
  readAutoStageTx,
  autoStageComplete,
  recordAutoStage,
  type AutoStageLedger,
  type AutoStageMark,
} from "./auto-stage-ledger.js";
export {
  autoPromoteGate,
  readTenantOptIn,
  readPlatformEnabled,
  readAutoPromoteEnabled,
  setAutoPromoteOptIn,
  setPlatformAutoPromote,
  PLATFORM_TENANT,
  STEPUP_ACTION,
  PLATFORM_STEPUP_ACTION,
  type AutoPromoteGateInput,
  type AutoPromoteGateResult,
  type SetOptInOpts,
} from "./autopromote-optin.js";
export {
  recordConsent,
  lookupConsent,
  type ConsentRecord,
  type RecordConsentInput,
  type LookupConsentInput,
} from "./runtime-consent-store.js";
