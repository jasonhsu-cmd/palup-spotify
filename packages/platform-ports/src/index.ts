export type {
  ModelPort,
  ModelRequest,
  ModelResponse,
  ModelMessage,
  EmbedRequest,
  EmbedResponse,
  EmbedPurpose,
} from "./model-port.js";
// Value exports for the OPTIONAL embed capability: the capability guard a caller uses to tell "this
// adapter cannot embed" from "the embedding call failed", the closed purpose vocabulary, and the two
// shared fail-closed validators every embedding adapter calls (mirrors VectorPort's requireCleanText).
export { EMBED_PURPOSES, canEmbed, requireEmbedInputs, requireEmbedAlignment } from "./model-port.js";
export type {
  GroundingPort,
  GroundingContext,
  GroundingShell,
  Product,
  StorePolicy,
} from "./grounding-port.js";
export type {
  JudgePort,
  JudgeInput,
  JudgeVerdict,
  JudgeCriterion,
  JudgeCriterionResult,
} from "./judge-port.js";
export type {
  CommercePort,
  Order,
  OrderItem,
  OrderHistorySummary,
  Subscription,
  CommercePolicy,
  SubscriptionActionResult,
  CustomerLastOrder,
  CustomerListingCommerce,
  MerchantOrderSummary,
  OrderListingCommerce,
} from "./commerce-port.js";
export {
  SUBSCRIPTION_SKIP_CAP,
  CommerceGuardRefusalError,
  SandboxCustomerDirectory,
  SandboxOrderDirectory,
} from "./commerce-port.js";
export type { StorePort } from "./store-port.js";
export type {
  RuntimeStatePort,
  RuntimeStateCtx,
  RuntimeStateTx,
  AuditInput,
  AuditRecord,
  // `PutOpts` was declared and used on the port's own `put` signature but never re-exported here, so
  // `state-postgres`'s adapter — which must type an identical signature — imported a member the barrel
  // did not provide. Never caught because nothing type-checked.
  PutOpts,
} from "./runtime-state-port.js";
export { AUDIT_GENESIS_HASH } from "./runtime-state-port.js";
export { InMemoryRuntimeStore } from "./in-memory-runtime-store.js";
export { canonicalize, hashAuditBase } from "./audit-hash.js";
export type { IdentityPort, Principal } from "./identity-port.js";
export { authorize, buildShopifyShopperId, shopperIdTenant } from "./identity-port.js";
export type {
  MerchantIdentityPort, MerchantPrincipal, AnonymousPrincipal, MerchantAuthResult,
  MerchantRole, AuthLevel, Permission,
} from "./merchant-identity-port.js";
export { DEFAULT_ROLE_PERMISSIONS, can, canApproveMoney } from "./merchant-identity-port.js";
export { createOperatorTokenIdentity } from "./operator-identity.js";
export { mintStepUp, verifyStepUp, STEPUP_MAX_AGE_MS, STEPUP_CLOCK_SKEW_MS, type StepUpClaims, type StepUpResult } from "./step-up.js";
export { createWidgetTokenIdentity, mintWidgetToken } from "./widget-token-identity.js";
export { createShopperTokenIdentity, mintShopperToken } from "./shopper-token-identity.js";
export { createGuestTokenIdentity, mintGuestToken, renewGuestToken, type GuestClaims } from "./guest-token-identity.js";
export { redactPII, createRedactingModelPort } from "./redaction.js";
export type { TelemetryPort, TelemetryEvent, TelemetryRollup, ModelTier } from "./telemetry-port.js";
export { createStoreTelemetry, rollupEvents } from "./telemetry-port.js";
export { createMeteringModelPort } from "./metering.js";
export type { ModelPrice, ModelPriceTable, CostBreakdown } from "./telemetry-cost.js";
export { deriveCostUsd, loadModelPrices, PLACEHOLDER_MODEL_PRICES } from "./telemetry-cost.js";
export { createCachingGroundingPort, invalidateGroundingCache } from "./grounding-cache.js";
export type { CachingGroundingOpts } from "./grounding-cache.js";
export type { SecretsPort } from "./secrets-port.js";
export { createEnvSecrets } from "./secrets-port.js";
export type { CryptoPort, AesGcmCryptoOpts, DerivedKey } from "./crypto-port.js";
export { createAesGcmCrypto, keyScopeSecretName, requireKeyScope, DEFAULT_KEY_SCOPE, deriveKey } from "./crypto-port.js";
export type {
  MerchantRegistryPort,
  MerchantRecord,
  MerchantSummary,
  MerchantStatus,
  MerchantRegion,
  MerchantGroundingMode,
  NewMerchant,
  MerchantUpdate,
  MerchantLookupOpts,
  InMemoryMerchantRegistryOpts,
} from "./merchant-registry-port.js";
export {
  createInMemoryMerchantRegistry,
  normalizePrimaryDomain,
  clampListActiveLimit,
  LIST_ACTIVE_DEFAULT_LIMIT,
  LIST_ACTIVE_MAX_LIMIT,
} from "./merchant-registry-port.js";
export type {
  Proposal,
  ProposalCategory,
  ProposalStatus,
  AgentAction,
  BoundaryReason,
  ReversalPlan,
  ProposalStore,
  ProposalListFilter,
  ProposalListResult,
  ProposalTransitionPatch,
} from "./proposal-store.js";
export { ttlForCategory, VersionConflictError, ProposalNotFoundError, InMemoryProposalStore } from "./proposal-store.js";
export type {
  CategoryRuleEnvelope,
  MerchantRuleSet,
  RuleProvenance,
  AutoActLimit,
  PalupFloor,
  RuleSetChangeResult,
  MerchantRulesStore,
  AutoEligibleDimension,
  SubscriptionSubAction,
  QuietHours,
} from "./merchant-rules-store.js";
export {
  PALUP_FLOORS,
  CONSERVATIVE_DEFAULTS,
  AUTO_ELIGIBLE_DIMENSIONS,
  effectiveCategory,
  mergeOverDefaults,
  isBigJump,
  InMemoryMerchantRulesStore,
  clampToFloor,
} from "./merchant-rules-store.js";
export type { RulePreset } from "./rule-presets.js";
export { CONSERVATIVE_DAY1_PRESET, VERTICAL_PRESETS, listPresets, findPreset } from "./rule-presets.js";
export type {
  PrimaryGoalKind,
  PrimaryGoal,
  PrimaryGoalSetInput,
  PrimaryGoalStore,
} from "./primary-goal-store.js";
export { PRIMARY_GOAL_KINDS, InMemoryPrimaryGoalStore } from "./primary-goal-store.js";
export type { VectorPort, VectorRecord, VectorQuery, VectorMatch, VectorListItem, VectorListOpts } from "./vector-port.js";
export { createInMemoryVectorStore, scoreRecord, requireCleanText } from "./vector-port.js";
export type { ProductFactsPort, ProductFact } from "./product-facts-port.js";
export { createInMemoryProductFactsStore, requireProductFactsTenant } from "./product-facts-port.js";
export type { StoreProfilePort, StoreProfileRecord } from "./store-profile-port.js";
export { createInMemoryStoreProfileStore, requireStoreProfileTenant } from "./store-profile-port.js";
export type { CatalogProductPort, CatalogProductRecord, CatalogProductVariant } from "./catalog-product-port.js";
export { createInMemoryCatalogProductStore, requireCatalogTenant } from "./catalog-product-port.js";
export type { PresentmentPricePort, PresentmentPrice } from "./presentment-price-port.js";
export { createInMemoryPresentmentPriceStore, requirePresentmentTenant, requirePresentmentCurrency } from "./presentment-price-port.js";
export type { QueuePort, QueueMessage, QueueHandler, QueueSubscription, DeadLetter } from "./queue-port.js";
export { createInMemoryQueue } from "./queue-port.js";
export type {
  CommsPort,
  CommsMessage,
  CommsChannel,
  CommsCheck,
  CommsDenyReason,
  SentMessage,
  LiveChatHandle,
  InMemoryComms,
  InMemoryCommsOpts,
  CampaignMessage,
  CampaignSendResult,
  CampaignCommsPort,
  RecordedCampaignMessage,
} from "./comms-port.js";
export { createInMemoryComms, CommsRejection, SandboxCommsAdapter } from "./comms-port.js";
export type {
  Play,
  Arm,
  OutcomeLedgerEntry,
  UsageLedgerEntry,
  ArmAgg,
  ArmTally,
  IncrementalLiftInput,
  IncrementalLiftResult,
} from "./outcome-ledger.js";
export { EMPTY_ARM_AGG, MIN_EXPOSURES_PER_ARM, computeIncrementalLift } from "./outcome-ledger.js";
export type { CartPort, CartLine, CartCheckout } from "./cart-port.js";
export { b64url, b64urlDecode, hmacSign, constantTimeEqual } from "./token-codec.js";
export type {
  LearnedCategory, LearnedTier, LearnedOrigin, ConfidenceTier, LearnedGrounding, LearnedInsight,
  InsightCandidate, GroundingVerdict, TeachingStance, LearnedListFilter, LearnedStore,
} from "./learned-store.js";
export {
  gradeInsight, isSafetyFloorViolation, SAFETY_CRITICAL_GUARDRAILS,
  INSIGHT_SURFACE_MIN_SAMPLE, INSIGHT_HIGH_CONFIDENCE_MIN_SAMPLE,
  InMemoryLearnedStore, LearnedInsightNotFoundError,
} from "./learned-store.js";
export type { AggregatePriorContribution, AggregatePrior, AggregatePriorStore } from "./aggregate-priors.js";
export {
  AGGREGATE_LEARNING_ADR_ACCEPTED, isAggregateLearningEnabled, MIN_CONTRIBUTING_MERCHANTS,
  anonymizePrivateInsight, InMemoryAggregatePriorStore,
} from "./aggregate-priors.js";
export type { Payout, PayoutsPort, FeeLine } from "./payouts-port.js";
export { SandboxPayoutsPort, requirePayoutsTenant, PALUP_ILLUSTRATIVE_TAKE_RATE, computeFeeLine } from "./payouts-port.js";
// W5 Task 7 — the ONE money-moving port in W5: dark by construction (default adapter records,
// never issues real money). Explicit named exports (not `export *`), same reason as the barrel's
// other value/type splits above.
export type { RefundRequest, RefundResult, RefundPort } from "./refund-port.js";
export { SandboxRefundAdapter } from "./refund-port.js";
// NB: the contract suite imports `vitest`, so it is NOT re-exported here (that would drag a devDep
// into every prod consumer of the index). Import it via the "./contract/runtime-state" subpath in tests.
