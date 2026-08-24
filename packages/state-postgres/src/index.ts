export { PostgresRuntimeStore } from "./postgres-runtime-store.js";
export { PostgresVectorStore } from "./postgres-vector-store.js";
// S3 — the pgvector-HNSW adapter (S1/A2, ADR-0020), exported so widget-backend's HEADLINE reconcile test
// (catalog-index-pgvector-reconcile.test.ts) can run the catalog-index job against the REAL ANN store
// without importing a vendor SQL detail — this is the same class `createVectorStore` selects internally
// under `VECTOR_ANN`, just reachable directly for a test that needs to name the adapter.
export { PgVectorStore, PgVectorTextQueryUnsupported } from "./pgvector-store.js";
export { PostgresProductFactsStore } from "./postgres-product-facts-store.js";
export { PostgresStoreProfileStore } from "./postgres-store-profile-store.js";
export { PostgresCatalogProductStore } from "./postgres-catalog-product-store.js";
export { PostgresPresentmentPriceStore } from "./postgres-presentment-price-store.js";
// E1 Task 8 adapter (`ProposalStore`, `@palup/platform-ports`). Exported so a later caller can wire it
// where staging needs durable proposals; the in-memory adapter (Task 2) stays the default until then.
export { PostgresProposalStore } from "./proposal-store.js";
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
// Task 4 (ADR-0022 F2) store. Distinct key scope/collection/record-key from the merchant-cred store above
// so a compromise or rotation of one credential kind never exposes the other — see the file header.
export {
  createAdminTokenStore,
  ADMIN_CRED_KEY_SCOPE,
  ADMIN_CRED_COLLECTION,
  ADMIN_CRED_RECORD_KEY,
  type AdminTokenStore,
  type AdminTokenStoreOpts,
  type AdminTokenRead,
  type AdminTokenWrite,
} from "./admin-token-store.js";
// W4-min task 5 adapter (`MerchantRulesStore`, `@palup/platform-ports`). Exported so `merchant-backend`'s
// `GET/PUT /rules` (task 4, not yet built) can wire it; the in-memory adapter stays the default until then.
export {
  PostgresMerchantRulesStore,
  type PostgresMerchantRulesStoreOpts,
} from "./merchant-rules-store.js";
export { PgPoolSql, pgPoolSqlFromUrl, type Sql } from "./sql.js";
export { createRuntimeStore } from "./factory.js";
export { createVectorStore } from "./vector-factory.js";
export {
  matchedKill,
  armKill,
  disarmKill,
  killStatus,
  RUNTIME_AGENT_TYPE,
  CATALOG_SYNC_AGENT_TYPE,
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
  readPlatformEnabled as readCatalogRetrievalPlatformEnabled,
  readTenantOptIn as readCatalogRetrievalTenantOptIn,
  catalogRetrievalEnabledFor,
  setPlatformEnabled as setCatalogRetrievalPlatformEnabled,
  setTenantOptIn as setCatalogRetrievalTenantOptIn,
  CATALOG_RETRIEVAL_PLATFORM_TENANT,
  type SetEnablementOpts,
} from "./catalog-retrieval-enablement.js";
export {
  recordConsent,
  lookupConsent,
  type ConsentRecord,
  type RecordConsentInput,
  type LookupConsentInput,
} from "./runtime-consent-store.js";
export { recordHealthDisclosure, lookupHealthDisclosure, type DisclosureInput } from "./runtime-disclosure-store.js";
export {
  revokeGuest,
  isGuestRevoked,
  type GuestRevocationRecord,
  type RevokeGuestInput,
  type IsGuestRevokedInput,
} from "./runtime-revocation-store.js";
export {
  accumulateArmTally,
  readArmTally,
  readArmTallyShards,
  readArmAggPair,
  listArmTallies,
  appendOutcomeLedgerEntry,
  readOutcomeLedger,
  type AccumulateArmTallyInput,
} from "./outcome-ledger-store.js";
