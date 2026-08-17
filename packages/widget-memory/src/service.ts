import { randomUUID, createHmac } from "node:crypto";
import type {
  RuntimeStatePort,
  VectorPort,
  VectorRecord,
  VectorListItem,
  ModelPort,
  CryptoPort,
  SecretsPort,
  EmbedRequest,
} from "@palup/platform-ports";
import { createAesGcmCrypto, createEnvSecrets, canEmbed, requireEmbedInputs, requireEmbedAlignment, deriveKey } from "@palup/platform-ports";
import { isMemoryEnabled } from "./flag.js";
import { subjectNamespace } from "./identity.js";
import { decideMemoryWrite } from "./consent.js";
import { consentPermitsFactClass } from "@palup/widget-brain";
import { classifyFact, type FactClass } from "./classifier.js";
import { sanitizeFact, createStubDistiller, createModelDistiller, isValidDisposition, type FactDistiller } from "./distiller.js";
import type { Disposition } from "./disposition.js";
import { buildMemoryAudit, subjectRef } from "./audit.js";
import { ttlForClass, RENEW_MIN_GAP_MS } from "./retention.js";
import { recordSubject } from "./subject-index.js";
import { readMemoryManifest, writeMemoryManifest, memoryPinMismatch, type MemoryManifest } from "./manifest.js";
import type { MemoryCtx, MemoryRecallOpts, MemoryService, MemoryTurn, RecalledFact, FactMetadata } from "./types.js";

// semantic-memory-v1, PR2 (write path) — T4 (embed ordinary / NEVER embed special / stamp `.vector`) and
// T5 (write-time dedup), both gated on the NEW, separately-reviewed MEMORY_SEMANTIC_RECALL flag (T9,
// default OFF — see `MemoryServiceDeps.semanticRecall`'s own doc comment for the gating discipline).
// Deliberately NOT folded into flag.ts's ADR-0015 double gate: that gate governs whether memory exists at
// all; this one governs whether an EXISTING memory write also carries a semantic vector. See this
// package's chat-memory-semantic-flag-off.test.ts for the standing proof that flag.ts's own source never
// references this name.

/**
 * Cosine-similarity floor above which an ORDINARY candidate collapses into an EXISTING record (T5: the
 * existing row is fully REPLACED in place with the new candidate's text/disposition/vector plus a fresh
 * `expiresAt` — a full upsert-in-place where the newest phrasing wins, NOT a TTL-only re-stamp of the old
 * content) instead of inserting a second row for what is very likely the same underlying preference,
 * restated. Overridable via `MEMORY_DEDUP_THRESHOLD` (parsed as a float).
 *
 * 0.95 IS A STARTING DEFAULT, NOT A TUNED VALUE — chosen the same way `DEFAULT_CATALOG_RETRIEVAL_K`
 * (widget-brain/src/brain.ts) was: a bound picked from first principles (near-paraphrase preferences
 * embed very close to 1.0; genuinely distinct preferences embed far below it — see this package's own
 * service-dedup.test.ts fixture, 0.9998 vs 0.0), not measured against real embeddings. Nothing in this
 * repo has measured false-merge (over-collapsing two genuinely distinct preferences into one row, quietly
 * losing a signal) or false-split (never collapsing true paraphrases) rates on real embeddings — that is
 * the eval gate's job (a promotion decision), not this PR's. SECURITY/FAIRNESS-ADJACENT: a threshold set
 * too low silently drops a shopper's own distinct, consented fact by merging it away; flagged for the
 * reviewer as eval-gated, not yet a measured guarantee.
 */
function dedupThreshold(): number {
  const raw = process.env.MEMORY_DEDUP_THRESHOLD;
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : 0.95;
}

/**
 * The embed dimension a fresh deployment is configured for — read once per call, never cached across
 * calls (an operator changing this env var must take effect on the next write, not require a restart-
 * detecting cache invalidation). Used ONLY as the special-category placeholder's fallback dimension when
 * no manifest pin exists yet for this tenant (T4's "placeholder dimension edge" — a special-ONLY subject
 * with no ordinary write yet to have pinned one). Defaults to 1536 — the same value
 * `docs/design/*`/state-postgres's pgvector store default assumes and the value this PR's own pgvector-
 * container proof (`service-pgvector-recall.test.ts`) builds its store with, so an unconfigured deployment
 * and its pgvector corpus agree on a dimension by default.
 */
function configuredEmbedDimension(): number {
  const raw = process.env.PALUP_EMBED_DIMENSION;
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : 1536;
}

/**
 * A Box-Muller Gaussian sample — dependency-free, no provider/vendor RNG (ADR-0001 has no bearing here,
 * but the discipline of "no external dependency for something this small" matches the rest of this repo).
 */
function randomGaussian(): number {
  let u = 0;
  let w = 0;
  while (u === 0) u = Math.random();
  while (w === 0) w = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * w);
}

/**
 * A RANDOM UNIT vector of the given dimension — THE PLACEHOLDER for a special-category fact's `.vector`
 * (T4's governance-critical rule: special-category plaintext is NEVER embedded, so this is deliberately
 * NOT derived from the fact's content in any way). Explicitly NOT a zero vector: pgvector's `<=>` cosine
 * operator errors on a zero-norm operand (ruling from this PR's test-engineer), so a zero vector would
 * make every special-category write reject on a real pgvector store the instant T4 landed. Each
 * component is an independent Gaussian sample normalized to unit length — the standard construction for a
 * uniformly-random point on the unit sphere, so the placeholder's DIRECTION carries no information about
 * the plaintext it stands in for (unlike, say, an all-ones or all-same-value vector, which is trivially
 * distinguishable and would itself leak "this is a placeholder, not real content" to anyone inspecting
 * stored vectors). The `while` guard is unreachable in practice (all-zero Gaussians have probability 0)
 * but never silently divides by zero.
 *
 * HONESTY NOTE for the reviewer: because this is genuinely random (not deterministically derived from the
 * record id or any other stable seed), its cosine similarity against any ONE fixed query vector is a
 * continuous random variable — in a LOW test dimension (the pgvector-recall proof uses dimension 4) there
 * is a small, quantifiable, non-zero probability that a placeholder happens to score unusually high
 * against a specific query by pure chance, exactly like any other random-direction construction in a
 * low-dimensional space. At this PR's production default dimension (1536) that probability is
 * astronomically small. This is an inherent property of "genuinely random, content-independent" — not a
 * bug — and is called out here rather than silently accepted.
 */
function randomUnitVector(dimension: number): number[] {
  let v: number[] = [];
  let norm = 0;
  do {
    v = Array.from({ length: dimension }, () => randomGaussian());
    norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  } while (norm === 0);
  return v.map((x) => x / norm);
}

/**
 * T5 — SPECIAL-category write-time dedup key: a keyed-HMAC-SHA256 over the SANITIZED plaintext (pre-
 * encryption), so an exact-repeat of the SAME special-category fact can be detected WITHOUT ever
 * comparing health/Art-9 text by vector similarity (that would require embedding it — the exact privacy
 * boundary T4 exists to prevent).
 *
 * KEY DISCIPLINE (security review, feat/memory-v1-pr2-write-path, finding 3.A): the HMAC key is DERIVED
 * from the tenant's already-provisioned `MEMORY_ENCRYPTION_KEY` secret via `deriveKey` (crypto-port.ts) —
 * the SAME tenant-mixing (HKDF `info` includes `tenantId`) and the SAME entropy floor
 * (`MIN_KEY_MATERIAL_BYTES`) that `createAesGcmCrypto` applies to the AES encryption key — NOT the raw
 * secret bytes directly. `deriveKey` is called with a purpose label (`"memory-dedup"`, folded into the
 * HKDF info as `"<tenantId>|memory-dedup"`) so this HMAC key is also DOMAIN-SEPARATED from the AES key:
 * the two keys never coincide even for the same tenant. Before this fix, the raw secret was hashed
 * directly with no tenant-mixing at all — two tenants provisioned with the IDENTICAL raw
 * `MEMORY_ENCRYPTION_KEY` (e.g. an unconfigured/shared-default deployment) produced the SAME tag for the
 * SAME health phrase: a cross-tenant equality oracle over special-category (Art-9) facts. Deriving the
 * tag key with `tenantId` mixed into the HKDF info closes that — two tenants sharing the identical raw
 * secret now get DIFFERENT tags for the identical plaintext, matching the ciphertext's own cross-tenant
 * separation (crypto-port.ts's stated invariant).
 *
 * Returns `undefined` (no tag, dedup simply skipped for this candidate) when no key is configured for
 * this tenant, OR when the configured material is below `MIN_KEY_MATERIAL_BYTES` (`deriveKey` throws;
 * caught here and treated identically to "no key" rather than falling back to an unkeyed/weak tag) — this
 * is NEVER the path that decides whether the special-category candidate itself is persisted (that
 * fail-closed decision is `encryptOrRefuse`'s alone, which independently refuses a below-floor key before
 * any tag would be persisted); a candidate with no dedup tag is stored exactly as before this PR, just
 * without dedup protection. SECURITY-RELEVANT, flagged for the reviewer: unlike `subjectRef`'s hmacKey
 * (which falls back to a PLAIN, unkeyed sha256 for a high-entropy guest anon id), this tag is computed
 * over free-text SHOPPER CONTENT from a small, guessable vocabulary (health/allergy/pregnancy phrasing) —
 * an unkeyed hash of that would be dictionary-attackable by anyone who can read `metadata.dedupTag`, so
 * this function has NO unkeyed fallback path; it is keyed (and tenant-derived) or it does not compute a
 * tag at all.
 */
async function specialDedupTag(secrets: SecretsPort, tenantId: string, plaintext: string): Promise<string | undefined> {
  const raw = await secrets.get(tenantId, "MEMORY_ENCRYPTION_KEY");
  if (!raw) return undefined;
  try {
    const { key } = deriveKey(tenantId, raw, "memory-dedup");
    return createHmac("sha256", key).update(plaintext).digest("hex");
  } catch {
    // Below MIN_KEY_MATERIAL_BYTES — deriveKey's own entropy floor. Treated exactly like "no key
    // configured": no tag, dedup skipped. Defense-in-depth, not the only enforcement of the floor:
    // `encryptOrRefuse` independently refuses the special candidate itself for the same reason
    // (`crypto.encrypt` also calls `deriveKey`), so a below-floor key never reaches a persisted tag either
    // way — but this function does not rely solely on that outer refusal.
    return undefined;
  }
}

// Bounded scan for the T5 special-category dedup lookup — same cap and the same "generous per-subject"
// reasoning as `RECALL_LIMIT` below (the vector port has no native "find by metadata field" op, so this
// is a plain keyset `list` scan filtered in application code).
const DEDUP_SCAN_LIMIT = 500;

/** Find an existing record in `namespace` whose `metadata.dedupTag` exactly equals `tag`, or `undefined`.
 *  A single bounded page (`DEDUP_SCAN_LIMIT`) — see its own doc comment for why that is an accepted,
 *  documented limit rather than an unbounded scan. */
async function findByDedupTag(vector: VectorPort, namespace: string, tag: string): Promise<string | undefined> {
  const page = await vector.list(namespace, { limit: DEDUP_SCAN_LIMIT });
  const hit = page.find((item) => (item.metadata as { dedupTag?: string } | undefined)?.dedupTag === tag);
  return hit?.id;
}

// ADR-0015 PR A (T7): wires flag -> consent -> classifier -> distiller -> VectorPort + audit. The
// double gate (flag.ts) is the outermost check on BOTH methods — when off, neither method touches the
// vector port or the audit log at all (not even a read), so shipping this package changes NOTHING on
// the /chat path until a later, explicitly-gated PR wires it in and flips the flag.

// ADR-0015 Inv 4/9 TTL day-counts (ORDINARY_TTL_DAYS / SPECIAL_TTL_DAYS) now live in retention.ts (T8) —
// the single source of truth, so this module and the retention/sweep module can never drift apart.

// GO-LIVE #2 — ENCRYPTION AT REST FOR SPECIAL-CATEGORY FACTS (ADR-0015 Inv 9). Encryption happens HERE,
// at the SERVICE layer, not inside any one `VectorPort` adapter — so ciphertext is the ONLY thing any
// adapter (the in-memory dev store, the durable Postgres adapter, a future cloud vector DB) ever sees.
// This is adapter-agnostic defense in depth: swapping the vector port never changes what protection a
// special-category fact gets, and it closes the durable Postgres adapter's tracked plaintext gap (see
// its own file header) WITHOUT that adapter needing to know anything about sensitivity classes at all.
//
// FAIL-CLOSED vs BEST-EFFORT (a deliberate, asymmetric trade-off — see `encryptOrRefuse` below):
//   - SPECIAL-CATEGORY candidates are encrypted FAIL-CLOSED: if no key is configured for this tenant
//     (`crypto.encrypt` throws), the candidate is REFUSED — dropped exactly like any other gate above it
//     (`mayWrite`/`shouldRemember`/disposition validation) — NEVER persisted in the clear. This is the
//     Inv 9 requirement: "special-category facts... stricter storage (encryption...)".
//   - ORDINARY candidates are encrypted BEST-EFFORT: the SAME encryption is attempted (defense in depth
//     costs nothing extra once a key exists), but if no key is configured the candidate falls back to
//     PLAINTEXT rather than being refused. Inv 9 only mandates encryption for special-category data;
//     making ordinary memory depend on a key too would be a new, unrequired operational dependency —
//     today ordinary memory needs zero configuration to work, and this preserves that. The trade-off is
//     explicit: an unconfigured deployment gets ordinary memory in the clear (identical to before this
//     PR) and NO special-category memory at all (refused, not degraded) until a key is provisioned.
//
// SIMILARITY-SEARCH TRADE-OFF (also deliberate, matching the durable Postgres adapter's own honesty
// note): encrypting `VectorRecord.text` (the port's own top-level field, not just `metadata.text`) means
// a GENUINE non-empty-text similarity query against an encrypted record can no longer score it
// meaningfully (`scoreRecord`'s lexical Jaccard operates on whatever string is in `text` — ciphertext
// tokens never overlap a plaintext query's tokens). This is ACCEPTABLE and already true of this system
// today: the ONLY real caller pattern is `query(namespace, {text: "", k: RECALL_LIMIT})` — the
// "list everything for this subject" idiom (see `RECALL_LIMIT`'s own note below) — and an EMPTY query
// string ties every record at score 0 regardless of whether `text` is plaintext or ciphertext (Jaccard
// over an empty token set is 0 either way), so list-all recall is byte-for-byte unaffected. A future
// genuinely-semantic similarity search over special-category facts would need to embed BEFORE encrypting
// (a `vector` field, scored separately from `text`) — out of scope here, not silently precluded.
//
// `encrypted` (types.ts `FactMetadata.encrypted`) records exactly which outcome happened for THIS
// record, so `recall` never has to guess from the string's shape whether to decrypt.
//
// SECURITY REVIEW (feat/memory-encryption-at-rest) fixes folded into this module:
//  - finding 1: `disposition.value` now gets the SAME protection `text`/`sourceQuote` get — previously
//    only `sourceQuote` was ever encrypted, so model-authored free text in `value` sat in the clear even
//    on a class:"special" row.
//  - finding 2 (the most important fix in this branch): `sourceQuote` is a SEPARATE span of the
//    shopper's own words that the fact's own classification does NOT cover — an Art-9 quote can ride on
//    an otherwise-ordinary fact. The sanitized quote is now independently classified and the STRICTER of
//    {fact class, quote class} governs the consent gate, the encryption decision, and the class stored on
//    the record, so such a candidate is treated as special end-to-end (Consent 2 required, encrypted
//    fail-closed, audited as special, purged by withdrawConsent2).
//  - finding 4: every encrypted field is bound via GCM additional authenticated data to
//    `${recordId}|${field}` (see `encryptOrRefuse`/`encryptAuxField` below) — a ciphertext relocated onto
//    a different record or a different field of the same record fails authentication rather than
//    decrypting cleanly. Deliberately NOT the namespace: a subject's namespace legitimately changes across
//    a guest->account merge (merge.ts) while the record id does not, and record id + field alone already
//    disambiguates every slot within a tenant.
//  - finding 6: a fail-closed special-category refusal now emits a PII-free `write.refused` audit
//    (class + count only, never text) instead of being entirely silent (ADR-0015 Inv 6 / NN#5).
//  - finding 9: `disposition.value`/`sourceQuote` encryption is routed through the same never-throws
//    helper as the fact text (`encryptAuxField`), never a bare `crypto.encrypt` call outside a try/catch.

// A generous per-subject cap on how many facts `recall` retrieves in one call. The vector port has no
// native "list all" op; querying with an empty text scores every record 0 (tie) and returns them in
// stable id order up to `k`, which is exactly "give me everything for this subject" for the modest
// per-subject fact counts this system deals in. ALSO reused (T7) as the overfetch `k` for the ranked
// semantic query below, before floor-exclusion filtering and the topK slice — the same "modest
// per-subject fact counts" reasoning applies: a subject's whole corpus fits comfortably under it, so
// filtering `mustRecall`/special rows out of an already-complete ranked list never starves the topK slice
// of a genuinely-near ordinary fact sitting just behind an excluded one.
const RECALL_LIMIT = 500;

/**
 * semantic-memory-v1 T7 (PR3, read path) — how many of a subject's own ORDINARY facts (mustRecall/special
 * rows excluded — see `recall()`) rank into the semantic slice, nearest-first. Overridable via
 * `MEMORY_RECALL_TOP_K` (parsed as an integer).
 *
 * 16 IS A STARTING DEFAULT, NOT A TUNED VALUE — chosen the same way `DEFAULT_CATALOG_RETRIEVAL_K`
 * (widget-brain/src/brain.ts) and this module's own `dedupThreshold` were: a bound picked from first
 * principles (wide enough that a handful of genuinely-relevant recalled facts almost never all miss it;
 * small enough that stale/tangential facts from a long-lived subject don't crowd the prompt), not measured
 * against real embeddings or real recall-quality. Nothing in this repo has measured recall@k for memory
 * facts — that is the eval gate's job (a promotion decision), not this PR's.
 */
function recallTopK(): number {
  const raw = process.env.MEMORY_RECALL_TOP_K;
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : 16;
}

/**
 * semantic-memory-v1 T7 — the bounded `VectorPort.list` page size for the SAFETY FLOOR enumerate: every
 * one of the subject's own `metadata.mustRecall === true` rows, regardless of similarity to the query.
 * Mirrors `DEDUP_SCAN_LIMIT`'s own "single bounded page, no native find-by-metadata-field op" reasoning —
 * this is NOT a tuned value either, just a generous cap matching this module's other per-subject bounds
 * (`RECALL_LIMIT`/`DEDUP_SCAN_LIMIT`, both 500) so a subject's whole corpus fits in one page. Overridable
 * via `MEMORY_FLOOR_CAP` (parsed as an integer).
 */
function recallFloorCap(): number {
  const raw = process.env.MEMORY_FLOOR_CAP;
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : 500;
}

/**
 * SECURITY-REVIEW FIX (feat/memory-v1-pr3-semantic-recall, HIGH finding — a shopper's allergy/health fact
 * could be silently dropped from recall entirely). This is the ONE predicate for "does this row belong to
 * the safety floor" and it is shared, byte-for-byte, between the ranked-set EXCLUSION (a floor row must
 * never rank — its vector is a content-independent random placeholder, T4) and the floor's own INCLUSION
 * test below. Before this fix the two were independently written and had drifted: the ranked exclusion
 * checked `mustRecall === true || class === "special"`, but the floor only re-included `mustRecall ===
 * true` — so a row with `class:"special"` and NO `mustRecall` (a special fact written to this subject
 * while `MEMORY_SEMANTIC_RECALL` was OFF — `mustRecall` is only ever stamped at write time under the flag,
 * `remember()` above — but `class:"special"` is the DURABLE marker erasure.ts already treats as
 * authoritative, `classOf` there filters on `class === "special"` alone) was excluded from ranking and
 * never re-added by the floor: dropped from recall with no signal to the shopper or an operator. Keying
 * the floor on the durable `class` marker, not just the flag-gated `mustRecall`, makes the floor's
 * inclusion set a guaranteed SUPERSET of whatever the ranked set excludes — the invariant this predicate
 * exists to hold structurally (one function, not two hand-kept-in-sync copies) rather than by convention.
 */
function isSafetyFloorRow(meta: { mustRecall?: boolean; class?: FactClass } | undefined): boolean {
  return meta?.mustRecall === true || meta?.class === "special";
}

/**
 * SECURITY-REVIEW FIX (same PR, MEDIUM finding) — the safety floor used to be a SINGLE bounded
 * `VectorPort.list` page (`recallFloorCap()`, default 500), no `after` continuation. `list` returns
 * ascending-id order and record ids are random UUIDs, so a subject with more than `recallFloorCap()` TOTAL
 * facts (ordinary + special combined, since the cap bounds the whole namespace page, not just the special
 * rows within it) saw only the lowest-UUID slice of their own corpus — any safety fact whose UUID happened
 * to sort past that page was silently dropped, independent of the Hole-1 predicate fix above.
 *
 * FIX: paginate to exhaustion, reusing erasure.ts's own `enumerateSubject` page-walk shape (`after` an
 * exclusive lower bound, loop until a short page terminates) — completeness for a safety-critical read
 * deserves the same discipline erasure.ts already applies to a safety-critical delete. `FLOOR_MAX_PAGES`
 * mirrors erasure.ts's `MAX_PAGES` reasoning verbatim: a backstop against a pathological/corrupt
 * namespace, not a normal-path limit (`FLOOR_MAX_PAGES * recallFloorCap()` = 1,000,000 rows at the default
 * cap — several orders of magnitude past any realistic per-subject fact count). Deliberately NOT a thrown
 * `PageCeilingExceeded` the way erasure.ts's enumeration is: erasure is a legal deletion action where an
 * incomplete purge must never be mistaken for a complete one, so escalating (to a defensive full erase) or
 * throwing is the only honest outcome; `recall()` is a READ inside a live chat turn, where throwing would
 * fail the shopper's whole turn over a backstop that should never fire in practice. So this degrades to
 * best-effort (returns whatever was collected) and LOGS (never silent — mirrors this module's other
 * `console.error` backstops, e.g. the embed-error catch in `remember()` above) rather than either silently
 * truncating or throwing.
 */
const FLOOR_MAX_PAGES = 2000;

async function enumerateFloor(vector: VectorPort, namespace: string, pageLimit: number, ref: string): Promise<VectorListItem[]> {
  const out: VectorListItem[] = [];
  let after: string | undefined;
  for (let page = 0; page < FLOOR_MAX_PAGES; page++) {
    const batch = await vector.list(namespace, { limit: pageLimit, after });
    out.push(...batch);
    if (batch.length < pageLimit) return out; // short page — namespace exhausted
    after = batch[batch.length - 1]!.id;
  }
  console.error(
    `[memory] safety-floor enumeration hit FLOOR_MAX_PAGES=${FLOOR_MAX_PAGES} (pageLimit=${pageLimit}) subjectRef=${ref} — using the partial floor collected so far; recall degrades best-effort here rather than failing the shopper's turn (unlike erasure.ts's own ceiling, which escalates)`,
  );
  return out;
}

interface EncryptedField {
  value: string;
  encrypted: boolean;
}

/**
 * Encrypts one piece of shopper-authored text with the asymmetric contract documented in the module
 * header: FAIL CLOSED for special-category text (a missing/unconfigured key means `undefined` — the
 * caller MUST refuse/drop the whole candidate, never persist a partial value) and BEST EFFORT for
 * ordinary text (falls back to the plaintext input unchanged). Never throws — any `crypto.encrypt`
 * failure (no key configured, or any other adapter error) is caught here so a candidate is refused
 * cleanly rather than the whole `remember()` call blowing up mid-batch. `aad` binds the resulting
 * ciphertext to this specific record/field (security review finding 4) — see the caller for how it's
 * built.
 */
async function encryptOrRefuse(
  crypto: CryptoPort,
  tenantId: string,
  factClass: FactClass,
  plaintext: string,
  aad: string,
): Promise<EncryptedField | undefined> {
  try {
    return { value: await crypto.encrypt(tenantId, plaintext, aad), encrypted: true };
  } catch {
    if (factClass === "special") return undefined; // fail closed (Inv 9) — refuse rather than persist plaintext
    return { value: plaintext, encrypted: false }; // ordinary best-effort fallback — see module header
  }
}

/**
 * Encrypts an AUXILIARY protected field (`disposition.value` / `sourceQuote`) once the fact's own text
 * has ALREADY been successfully encrypted (`encryptOrRefuse` returned `encrypted: true`) — so this never
 * needs its own fail-closed/best-effort branching, only "never throw" (security review finding 9): a
 * transient adapter error here is caught and reported as `undefined` so the caller can refuse the WHOLE
 * candidate (mirroring `encryptOrRefuse`'s own special-category refusal) rather than crash `remember()`
 * mid-batch or persist a record with some protected fields encrypted and others not under one shared
 * `FactMetadata.encrypted` flag.
 */
async function encryptAuxField(
  crypto: CryptoPort,
  tenantId: string,
  aad: string,
  plaintext: string,
): Promise<string | undefined> {
  try {
    return await crypto.encrypt(tenantId, plaintext, aad);
  } catch {
    return undefined;
  }
}

export interface MemoryServiceDeps {
  vector: VectorPort;
  /** The RuntimeStatePort's audit surface (ADR-0015 Inv 6) — reused as-is, no new audit mechanism. */
  audit: RuntimeStatePort;
  /** The extractor to use. Optional: if omitted, one is derived from `model` (a governed, model-backed
   * `createModelDistiller` — ADR-0015 Inv 11, PR-6) or, failing that, `createStubDistiller()` (the
   * offline passthrough placeholder). Supplying `distiller` directly always wins over `model`. */
  distiller?: FactDistiller;
  /** `ModelPort` backing a real extractor when `distiller` isn't supplied directly (ADR-0001: feature
   * code never touches a provider SDK). Threaded here so a caller can hand the service a model instead
   * of constructing `createModelDistiller` itself. Still fully inert: unreachable while the flag.ts
   * double gate is off — `remember()` returns before `distiller.distill()` (hence `model.complete()`)
   * ever runs. */
  model?: ModelPort;
  /** Override for tests; defaults to the real `classifyFact`. */
  classifier?: typeof classifyFact;
  /** Override for deterministic TTL tests; defaults to `() => new Date()`. */
  clock?: () => Date;
  /** TEST SEAM ONLY — honored solely under the test runner (see createMemoryService). In production the
   * flag.ts double gate is authoritative and this field is IGNORED, so no caller can enable memory by
   * config (NN#1). Defaults to `isMemoryEnabled()`. */
  enabled?: boolean;
  /** `SecretsPort` backing the DEFAULT `CryptoPort` (ADR-0015 Inv 9 — encryption-at-rest). Optional:
   * defaults to `createEnvSecrets()` (reads `PALUP_SECRETS`), mirroring how `distiller` is derived from
   * `model` when omitted. Ignored entirely when `crypto` is supplied directly. */
  secrets?: SecretsPort;
  /** `CryptoPort` used to encrypt/decrypt fact text + `disposition[].value`/`sourceQuote` at rest
   * (ADR-0015 Inv 9). Optional: defaults to `createAesGcmCrypto(secrets)`. Overriding this directly is
   * the test seam for exercising specific key-present/absent scenarios without touching env vars —
   * supplying it always wins over `secrets`. */
  crypto?: CryptoPort;
  /** MEDIUM finding (security-review remediation, PR #152) — keyed-HMAC key for every audit
   * `subjectRef` this service writes (audit.ts's own doc comment). Optional: omitted falls back to a
   * plain sha256, safe only for a high-entropy guest anon id — required for an `acct:` subject's ref to
   * be genuinely pseudonymous rather than brute-forceable. Mirrors server.ts's `AUDIT_HMAC_SECRET`. */
  hmacKey?: string;
  /**
   * semantic-memory-v1 T9 — the DARK-SHIP flag for T4 (embed ordinary / never embed special)/T5
   * (write-time dedup). Optional override, paralleling `enabled`'s own override seam: when omitted,
   * defaults to a PLAIN env read, `process.env.MEMORY_SEMANTIC_RECALL === "true"` — unlike `enabled`,
   * this is NOT restricted to "test runner only", because `MEMORY_SEMANTIC_RECALL` is a genuinely new,
   * separately-reviewed, default-OFF operator flag (T9), not a route around flag.ts's ADR-0015 double
   * gate (which remains the OUTER, authoritative check on whether `remember`/`recall` do anything at
   * all — see `enabled` above). Deliberately NOT folded into `flag.ts`/`isMemoryEnabled` — see
   * chat-memory-semantic-flag-off.test.ts's own standing pin that flag.ts's source never references this
   * name. OFF (unset, or any value other than the exact string "true") is BYTE-IDENTICAL to this PR never
   * having shipped: no embed call, no manifest read/write, no vector on any record, no dedup.
   */
  semanticRecall?: boolean;
}

export function createMemoryService(deps: MemoryServiceDeps): MemoryService {
  const classify = deps.classifier ?? classifyFact;
  const clock = deps.clock ?? (() => new Date());
  const distiller = deps.distiller ?? (deps.model ? createModelDistiller({ model: deps.model }) : createStubDistiller());
  // ADR-0015 Inv 9 — encryption-at-rest. Mirrors `distiller`'s own derivation pattern: an explicit
  // `crypto` always wins; otherwise derive one from `secrets` (defaulting THAT to `createEnvSecrets()`,
  // i.e. `PALUP_SECRETS`) via the local AES-256-GCM adapter. A cloud-KMS adapter swaps in later by
  // passing `crypto` directly — this module never constructs a vendor SDK itself (ADR-0001).
  const secrets = deps.secrets ?? createEnvSecrets();
  const crypto = deps.crypto ?? createAesGcmCrypto(secrets);
  // The `deps.enabled` override is a test seam so the live path can be exercised without flipping
  // MEMORY_ADR_ACCEPTED. It is honored ONLY under a test runner; in production the double gate
  // (isMemoryEnabled) is authoritative, so a config value can never turn this package on (NN#1 — this
  // preserves flag.ts's "no caller can flip this on by config alone" guarantee by construction).
  const underTest = process.env.VITEST === "true" || process.env.NODE_ENV === "test";
  const enabled = underTest ? (deps.enabled ?? isMemoryEnabled()) : isMemoryEnabled();
  // T9 — see MemoryServiceDeps.semanticRecall's own doc comment for why this reads unconditionally
  // (not test-runner-gated like `enabled` above): it is a new, separately-reviewed, default-off flag in
  // its own right, not a way around the ADR-0015 double gate `enabled` already enforces. Read FRESH on
  // every call (never memoized into a `const` at construction time) — mirroring `dedupThreshold()`/
  // `configuredEmbedDimension()`/`recallTopK()`/`recallFloorCap()` below — so a caller that flips the env
  // var AFTER constructing the service (or between a `remember()` and a later `recall()`) is honored
  // exactly as if it had been set from the start; an explicit `deps.semanticRecall` override always wins,
  // regardless of the env var, exactly like before.
  const semanticRecallOn = () => deps.semanticRecall ?? process.env.MEMORY_SEMANTIC_RECALL === "true";

  async function remember(ctx: MemoryCtx, turn: MemoryTurn): Promise<{ written: FactClass[] }> {
    if (!enabled) return { written: [] }; // INERT — no vector call, no audit, nothing touched

    const capability = decideMemoryWrite({ region: ctx.region, consent1: ctx.consent1, consent2: ctx.consent2 });
    const candidates = await distiller.distill(turn);
    const namespace = subjectNamespace(ctx.tenantId, ctx.anonId);
    const now = clock().getTime();

    // T4 — this tenant's memory-corpus embed pin, read AT MOST ONCE per `remember()` call and cached
    // across every candidate in this turn (so a special candidate later in the SAME turn can see the
    // dimension an ordinary candidate earlier in the SAME turn just pinned, without a second KV read —
    // see `currentManifest`'s call sites below for exactly why that matters).
    let cachedManifest: MemoryManifest | null | undefined; // undefined = not read yet this call
    async function currentManifest(): Promise<MemoryManifest | null> {
      if (cachedManifest === undefined) cachedManifest = await readMemoryManifest(deps.audit, { tenantId: ctx.tenantId });
      return cachedManifest;
    }

    const written: FactClass[] = [];
    const ordinaryRecords: VectorRecord[] = [];
    const specialRecords: VectorRecord[] = [];
    // Security review finding 6 — a fail-closed special-category refusal must not be silent (ADR-0015
    // Inv 6 / NN#5): tallied across the whole turn and audited once below (PII-free: class + count only).
    let refusedSpecial = 0;
    // A refused ORDINARY candidate is far lower stakes than a refused special one (encryption is
    // best-effort for ordinary, so this only happens on a genuine adapter error once a key exists —
    // realistic when a KMS adapter lands), but the same "no silent memory action" principle applies:
    // silently discarding a fact the shopper consented to is an availability event an operator should
    // be able to see. Counted separately so the audit records the class honestly.
    let refusedOrdinary = 0;

    for (const rawCandidate of candidates) {
      const sanitized = sanitizeFact(rawCandidate.text);
      if (!sanitized) continue; // Inv 1: never a raw transcript / un-redacted PII

      const { class: factClass, remember: shouldRemember } = classify(sanitized, ctx.tenantPolicy);
      if (!shouldRemember) continue; // tenant policy narrowed this category out (Inv 11)

      // PR-8 — surface the validated disposition alongside the fact (previously discarded by the
      // distiller). Re-validated HERE with the SAME `isValidDisposition` (reject-in-full, no "inferred"
      // provenance, per-axis controlled vocabulary — security review finding 1) regardless of which
      // `FactDistiller` produced it — defense-in-depth at the actual persistence boundary, not just
      // inside `createModelDistiller`: an invalid disposition rejects the WHOLE candidate (mirrors
      // createModelDistiller's own reject-in-full rule), not just the disposition field, so a distiller
      // that skipped its own validation can never smuggle a tainted disposition through by attaching it
      // to an otherwise-fine fact.
      const rawDisposition = rawCandidate.disposition;
      if (rawDisposition !== undefined && !isValidDisposition(rawDisposition)) continue;

      // Security review finding 2 (the most important fix in this branch): `sourceQuote` is a SEPARATE
      // span of the shopper's own words that the FACT's own classification does not cover — an Art-9
      // quote ("I'm on tretinoin so I need fragrance-free") can ride on an otherwise-ordinary fact
      // ("prefers fragrance-free") and, unfixed, would inherit the ordinary fact's protection level:
      // written under Consent 1 alone, stored in the clear when no key is configured, and never purged by
      // `withdrawConsent2` (erasure.ts filters on `class === "special"`). Fixed by classifying the
      // SANITIZED quote too (same `sanitizeFact` treatment the quote gets below) and taking the STRICTER
      // of {fact class, quote class} BEFORE the consent gate, the encryption decision, and the class
      // stored on the record — so such a candidate is treated as special end-to-end regardless of what
      // the distilled fact text alone would have classified as.
      const sanitizedQuote = rawDisposition?.sourceQuote ? sanitizeFact(rawDisposition.sourceQuote) : null;
      const quoteClassification = sanitizedQuote ? classify(sanitizedQuote, ctx.tenantPolicy) : undefined;
      // Inv 11 (narrow-only tenant policy) applies to the QUOTE as well as the fact. Taking only `.class`
      // from the quote's classification and dropping its `.remember` would let a category the tenant has
      // explicitly narrowed out (`dropCategories`) still be persisted, just because it rode in on an
      // otherwise-ordinary fact's sourceQuote. The tenant's narrowing decision governs whichever span
      // triggered the category, so a quote the policy says not to remember drops the whole candidate.
      if (quoteClassification && !quoteClassification.remember) continue;
      const effectiveClass: FactClass = quoteClassification?.class === "special" ? "special" : factClass;

      const mayWrite = effectiveClass === "special" ? capability.mayWriteSpecial : capability.mayWriteOrdinary;
      if (!mayWrite) continue; // consent gate (Inv 3 / Inv 9) — gated on the STRICTER combined class

      // T4/T5 (semantic-memory-v1 PR2, gated on MEMORY_SEMANTIC_RECALL — T9). OFF is a complete no-op:
      // `candidateVector` stays undefined (byte-identical VectorRecord to pre-PR) and `dedupTargetId`
      // stays undefined (always a fresh id, exactly like before this PR).
      let candidateVector: number[] | undefined;
      let mustRecall = false;
      let dedupTag: string | undefined;
      let dedupTargetId: string | undefined; // set ⇒ this candidate COLLAPSES into an EXISTING record

      if (semanticRecallOn()) {
        if (effectiveClass === "special") {
          // THE PRIVACY BOUNDARY (governance-critical — the Art-9 leak guard this PR's tests pin): a
          // special-category candidate's plaintext is NEVER sent to embed, regardless of whether the
          // class came from the fact itself or from a sourceQuote promotion above. Its `.vector` is a
          // RANDOM UNIT placeholder (never all-zero — see `randomUnitVector`'s own doc comment), sized to
          // whatever dimension is already pinned for this tenant (an ordinary embed earlier in THIS turn,
          // or a prior call) — falling back to the deployment's configured dimension only when no pin
          // exists at all yet (the "placeholder dimension edge": a special-ONLY subject, first write).
          const manifest = await currentManifest();
          candidateVector = randomUnitVector(manifest?.dimension ?? configuredEmbedDimension());
          mustRecall = true;

          // T5 — special-category dedup: EXACT-MATCH ONLY, via a keyed-HMAC over the sanitized plaintext
          // (pre-encryption). NEVER a vector similarity computation over health/Art-9 text.
          dedupTag = await specialDedupTag(secrets, ctx.tenantId, sanitized);
          if (dedupTag) dedupTargetId = await findByDedupTag(deps.vector, namespace, dedupTag);
        } else if (deps.model && canEmbed(deps.model)) {
          try {
            const embedReq: EmbedRequest = { texts: [sanitized], purpose: "document", tenantId: ctx.tenantId };
            requireEmbedInputs(embedReq); // same shared validator every adapter itself must call
            const embedRes = await deps.model.embed(embedReq);
            requireEmbedAlignment(embedReq, embedRes);

            const manifest = await currentManifest();
            if (manifest && memoryPinMismatch(manifest, { model: embedRes.model, dimension: embedRes.dimension })) {
              // Refuse a CROSS-SPACE vector (mirrors the catalog corpus's own pin-mismatch refusal,
              // catalog-index.ts `pinMismatch`): mixing vector spaces in one subject's corpus makes
              // similarity meaningless. Refused exactly like any other candidate this turn drops —
              // counted, never silent (finding 6's discipline extended to this new refusal reason).
              refusedOrdinary++;
              continue;
            }
            candidateVector = embedRes.vectors[0];
            if (!manifest) {
              // First embedded write for this tenant — pin it, WITH an audit record (T3's own "no silent
              // write" discipline), before any candidate in this call relies on the dimension it fixes.
              const fresh: MemoryManifest = { model: embedRes.model, dimension: embedRes.dimension, purpose: "document", at: new Date(now).toISOString() };
              await writeMemoryManifest(deps.audit, { tenantId: ctx.tenantId }, fresh);
              cachedManifest = fresh;
            }

            // T5 — ordinary-fact dedup: cosine similarity against this subject's EXISTING vectors (never
            // against sibling candidates from this same turn, which are not upserted until after this
            // loop — so a batch of near-duplicate candidates in ONE turn is not itself de-duplicated,
            // only against what was already durably stored).
            const top = await deps.vector.query(namespace, { vector: candidateVector, k: 1 });
            // Defense-in-depth (security review, finding 5): a SPECIAL-category record's `.vector` is a
            // content-independent RANDOM placeholder (`randomUnitVector` above), so an ordinary query can
            // in principle score it above threshold by pure chance — negligible probability at this
            // deployment's real embed dimension (1536), but non-zero, and the `mustRecall`/special-class
            // exclusion that would otherwise prevent this is PR3's recall-side work, not this PR's. Fail
            // safe: never let an ordinary dedup collapse into a special placeholder row — treat a match on
            // one as no dedup hit at all (skip it), never overwrite it in place.
            const topMeta = top[0]?.metadata as { mustRecall?: boolean; class?: FactClass } | undefined;
            const topIsSpecialPlaceholder = topMeta?.mustRecall === true || topMeta?.class === "special";
            if (top[0] && !topIsSpecialPlaceholder && top[0].score >= dedupThreshold()) dedupTargetId = top[0].id;
          } catch (e) {
            // Never let an embed-provider hiccup break the turn — the fact is still worth storing
            // without a semantic vector this one time (byte-identical to the flag being off for THIS
            // candidate only; every OTHER candidate in the turn is unaffected).
            console.error(`[memory] embed error tenant=${ctx.tenantId} error=${e instanceof Error ? e.constructor.name : typeof e}`);
          }
        }
      }

      // Security review finding 4 — bind every encrypted field to THIS specific record (and which field
      // of it) via GCM additional authenticated data, so a ciphertext copied onto a different record, or
      // onto a different field of the SAME record, fails authentication rather than decrypting cleanly.
      // Built from the record's own id — either a FRESH one, or (T5 dedup hit) the EXISTING record's own
      // id, so the dedup-hit case is a genuine full upsert-in-place (newest candidate's text/disposition/
      // vector + a fresh `expiresAt`, NOT a TTL-only re-stamp of the old content) rather than a second row
      // — plus a field discriminator. Deliberately NOT the namespace: a subject's namespace legitimately changes across
      // a guest->account merge (merge.ts) while the record id does not, and record id + field alone
      // already disambiguates every slot within a tenant (cross-tenant relocation is independently
      // defeated by CryptoPort's own tenant-scoped key derivation).
      const recordId = dedupTargetId ?? randomUUID();
      const aadFor = (field: string) => `${recordId}|${field}`;

      // ADR-0015 Inv 9 — encrypt (or, for special-category with no key, REFUSE) before this fact ever
      // reaches a VectorRecord — see the module-header note for the full fail-closed/best-effort
      // contract. This must happen BEFORE building `metadata`/`record` below: nothing downstream of this
      // line may ever see the plaintext of a special-category fact whose encryption was refused, because
      // refusal means `continue` — the candidate never becomes a record at all.
      const encryptedFact = await encryptOrRefuse(crypto, ctx.tenantId, effectiveClass, sanitized, aadFor("text"));
      if (!encryptedFact) {
        if (effectiveClass === "special") refusedSpecial++; // finding 6 — never silent
        else refusedOrdinary++;
        continue;
      }

      // Security review finding 1 — `disposition.value` gets the SAME protection level the fact text just
      // received: previously only `sourceQuote` was ever encrypted, so model-authored free text in
      // `value` sat in the clear even on a class:"special" row. Security review finding 9 — both
      // auxiliary fields are encrypted through the SAME never-throws helper as the fact text
      // (`encryptAuxField`, never a bare `crypto.encrypt` call outside a try/catch), so a transient
      // adapter error can never blow up the whole `remember()` call mid-batch — it just refuses this one
      // candidate, exactly like a fact-text encryption failure would. Both are only attempted when the
      // fact text itself was actually encrypted (`encryptedFact.encrypted`); when no key is configured at
      // all, everything on this candidate stays consistently plaintext (the existing ordinary
      // best-effort fallback) rather than ending up half-encrypted under one shared `encrypted` flag.
      let dispositionValue = rawDisposition?.value;
      let sourceQuote = sanitizedQuote ?? undefined;
      if (encryptedFact.encrypted) {
        let auxFailed = false;
        if (rawDisposition) {
          const encryptedValue = await encryptAuxField(crypto, ctx.tenantId, aadFor("dispositionValue"), rawDisposition.value);
          if (encryptedValue === undefined) auxFailed = true;
          else dispositionValue = encryptedValue;
        }
        if (!auxFailed && sanitizedQuote) {
          const encryptedQuote = await encryptAuxField(crypto, ctx.tenantId, aadFor("sourceQuote"), sanitizedQuote);
          if (encryptedQuote === undefined) auxFailed = true;
          else sourceQuote = encryptedQuote;
        }
        if (auxFailed) {
          if (effectiveClass === "special") refusedSpecial++; // finding 6 — never silent
          else refusedOrdinary++;
          continue; // never persist a record with some protected fields encrypted and others not
        }
      }

      const disposition: Disposition[] | undefined = rawDisposition
        ? [{ ...rawDisposition, value: dispositionValue!, sourceQuote }]
        : undefined;

      const metadata: FactMetadata = {
        text: encryptedFact.value,
        class: effectiveClass,
        expiresAt: new Date(now + ttlForClass(effectiveClass)).toISOString(),
        disposition,
        encrypted: encryptedFact.encrypted,
        // T4/T5 — only ever set when MEMORY_SEMANTIC_RECALL is on; absent (not `false`/empty-string)
        // otherwise, so a flag-off record is byte-identical to what this PR's predecessor would write.
        ...(mustRecall ? { mustRecall: true } : {}),
        ...(dedupTag !== undefined ? { dedupTag } : {}),
      };
      // The vector record's OWN `text` field is encrypted identically to `metadata.text` (same value) —
      // see the module-header "similarity-search trade-off" note for what this costs and why it's fine.
      // `vector` (T4) is derived from the SANITIZED PLAINTEXT for an ordinary fact (never re-derived from
      // `encryptedFact.value`/ciphertext) and is a content-independent RANDOM placeholder for a special
      // one — either way it is `undefined` whenever `semanticRecallEnabled` is off, exactly as before.
      const record: VectorRecord = { id: recordId, text: encryptedFact.value, metadata, vector: candidateVector };
      written.push(effectiveClass);
      (effectiveClass === "special" ? specialRecords : ordinaryRecords).push(record);
    }

    if (ordinaryRecords.length > 0) {
      await deps.vector.upsert(namespace, ordinaryRecords);
      await deps.audit.audit(
        { tenantId: ctx.tenantId },
        buildMemoryAudit({
          action: "write.ordinary",
          tenantId: ctx.tenantId,
          anonId: ctx.anonId,
          factClass: "ordinary",
          count: ordinaryRecords.length,
          hmacKey: deps.hmacKey,
        }),
      );
    }
    if (specialRecords.length > 0) {
      await deps.vector.upsert(namespace, specialRecords);
      await deps.audit.audit(
        { tenantId: ctx.tenantId },
        buildMemoryAudit({
          action: "write.special",
          tenantId: ctx.tenantId,
          anonId: ctx.anonId,
          factClass: "special",
          count: specialRecords.length,
          hmacKey: deps.hmacKey,
        }),
      );
    }
    // B4 (2026-08-05) — index this subject so the SCHEDULED sweep can reclaim their expired facts even
    // if they never chat again (retention.ts `sweepAllSubjects`). Keyed off records actually PERSISTED,
    // not off the turn happening: a shopper who is opted out, refused, or produced no candidate facts
    // has nothing stored, so indexing them would put a subject with no data into the sweep's work list.
    //
    // BEST-EFFORT BY DESIGN. A failure here must never fail the turn or undo a fact that is already
    // durably written and audited — the shopper's memory is not damaged by a bookkeeping miss. The
    // honest cost of that choice: a subject whose index write failed is invisible to the SCHEDULED
    // sweep, so their expired facts are reclaimed only if they return (the per-turn sweep) — which is
    // exactly the pre-B4 behaviour, not a regression. TTL-on-read still means nothing expired is ever
    // served. PII-free signal (error CLASS + hashed subjectRef only), matching retention.ts's rule.
    if (ordinaryRecords.length > 0 || specialRecords.length > 0) {
      try {
        await recordSubject(deps.audit, { tenantId: ctx.tenantId, subject: ctx.anonId, now: clock() });
      } catch (e) {
        console.error(
          `[memory] subject-index write failed tenant=${ctx.tenantId} subjectRef=${subjectRef(ctx.tenantId, ctx.anonId, deps.hmacKey)} error=${e instanceof Error ? e.constructor.name : typeof e} — fact IS stored; this subject will be reclaimed on their own next visit rather than by the scheduled sweep`,
        );
      }
    }
    if (refusedSpecial > 0) {
      // Security review finding 6 (ADR-0015 Inv 6 / NN#5 — no silent memory action): a fail-closed
      // refusal is itself an event an operator needs visibility into ("memory is live, consent was
      // given, and nothing is being stored because no key is provisioned") — PII-free (class + count
      // only, never text), exactly like every other memory audit action.
      await deps.audit.audit(
        { tenantId: ctx.tenantId },
        buildMemoryAudit({
          action: "write.refused",
          tenantId: ctx.tenantId,
          anonId: ctx.anonId,
          factClass: "special",
          count: refusedSpecial,
          hmacKey: deps.hmacKey,
        }),
      );
    }
    if (refusedOrdinary > 0) {
      await deps.audit.audit(
        { tenantId: ctx.tenantId },
        buildMemoryAudit({
          action: "write.refused",
          tenantId: ctx.tenantId,
          anonId: ctx.anonId,
          factClass: "ordinary",
          count: refusedOrdinary,
          hmacKey: deps.hmacKey,
        }),
      );
    }

    return { written };
  }

  async function recall(ctx: MemoryCtx, opts?: MemoryRecallOpts): Promise<RecalledFact[]> {
    if (!enabled) return []; // INERT — no vector call, no audit, nothing touched

    const namespace = subjectNamespace(ctx.tenantId, ctx.anonId);
    const now = clock().getTime();

    // T7 (semantic-memory-v1, PR3) — semantic ranked-set + safety-floor UNION, gated on
    // MEMORY_SEMANTIC_RECALL AND a `queryVector`/`pin` that matches this TENANT's own memory-corpus
    // manifest (mixing vector spaces is meaningless — mirrors the write-side `memoryPinMismatch` refusal).
    // Anything else — flag off, no queryVector, no pin, no manifest yet, or a pin mismatch — falls through
    // to the EXACT pre-PR3 list-all baseline below, byte-identical to `recall()` never having taken a
    // second argument at all.
    const pinSupplied = semanticRecallOn() && opts?.queryVector !== undefined && opts?.pin !== undefined;
    let manifest: MemoryManifest | null = null;
    if (pinSupplied) manifest = await readMemoryManifest(deps.audit, { tenantId: ctx.tenantId });
    const useSemantic = pinSupplied && manifest !== null && !memoryPinMismatch(manifest, opts!.pin!);

    let matches: Array<{ id: string; metadata?: Record<string, unknown> }>;
    if (useSemantic) {
      // The ranked half: overfetch (RECALL_LIMIT, same generous per-subject cap as the fallback query
      // below) so filtering `mustRecall`/special rows out never starves the topK slice of a genuinely-near
      // ordinary fact sitting just behind an excluded one, THEN cap to `recallTopK()`, nearest-first.
      const rankedRaw = await deps.vector.query(namespace, { vector: opts!.queryVector, k: RECALL_LIMIT });
      const ranked = rankedRaw
        // A safety-floor row (see `isSafetyFloorRow`'s own doc comment) NEVER ranks — its vector is a
        // content-independent random placeholder (T4), so scoring it against a query is meaningless — and
        // it always surfaces via the floor below instead, regardless of similarity.
        .filter((m) => !isSafetyFloorRow(m.metadata as { mustRecall?: boolean; class?: FactClass } | undefined))
        .slice(0, recallTopK());

      // The safety floor: EVERY row matching `isSafetyFloorRow` for this subject — `mustRecall === true`
      // OR the durable `class === "special"` marker, the SAME predicate the ranked exclusion above uses,
      // so the floor's inclusion set is a guaranteed superset of whatever ranking excluded (a `class:
      // "special"` row written before MEMORY_SEMANTIC_RECALL existed carries no `mustRecall` but still
      // surfaces here) — regardless of similarity to the query. Paginated to EXHAUSTION (`enumerateFloor`,
      // mirroring erasure.ts's own completeness discipline), not a single bounded page: a subject with more
      // total facts than one page's `recallFloorCap()` must not have a safety fact silently fall past the
      // page boundary. Deduped by id against the ranked half above.
      const floorPage = await enumerateFloor(deps.vector, namespace, recallFloorCap(), subjectRef(ctx.tenantId, ctx.anonId, deps.hmacKey));
      const seenIds = new Set(ranked.map((m) => m.id));
      matches = [...ranked];
      for (const item of floorPage) {
        const meta = item.metadata as { mustRecall?: boolean; class?: FactClass } | undefined;
        if (isSafetyFloorRow(meta) && !seenIds.has(item.id)) {
          matches.push(item);
          seenIds.add(item.id);
        }
      }
    } else {
      matches = await deps.vector.query(namespace, { text: "", k: RECALL_LIMIT });
    }

    const facts: RecalledFact[] = [];
    // Security review finding 5 — a record dropped because it would not decrypt is a real operator event:
    // a tampered or relocated ciphertext, or (most likely) a key rotated without keeping the outgoing
    // value at `<name>_previous`, silently removes a shopper's memory from every future recall. Counted
    // here and emitted as a PII-free `recall.dropped` audit below, so rotation damage is DETECTABLE
    // rather than showing up only as memory that quietly stopped working.
    let undecryptable = 0;
    const renewed: VectorRecord[] = []; // sliding-retention re-stamps (ADR-0015 Inv 4 amendment, 2026-08-04)
    for (const match of matches) {
      const meta = match.metadata as Partial<FactMetadata> | undefined;
      if (!meta?.text || !meta.class) continue;
      const expiresMs = meta.expiresAt ? new Date(meta.expiresAt).getTime() : undefined;
      if (expiresMs !== undefined && expiresMs <= now) continue; // TTL-on-read (Inv 4): expired ⇒ not served, never renewed

      // Security review finding 4 — decrypt must present the SAME aad used at encrypt time
      // (`${recordId}|${field}`, built from this MATCH's own id, which is identical to the record id
      // `remember()` minted — stable across sliding-retention re-stamps AND a guest->account merge,
      // see `aadFor`'s own note in `remember()`). A mismatched aad (a relocated ciphertext) fails
      // authentication exactly like a tampered ciphertext — both collapse to `undefined` below.
      const aadFor = (field: string) => `${match.id}|${field}`;

      // ADR-0015 Inv 9 — decrypt on read. `meta.encrypted` is set precisely at WRITE time (never
      // inferred from the string's shape — types.ts's `FactMetadata.encrypted` doc), so a plaintext
      // record (the ordinary no-key fallback, or one seeded directly at the vector-port layer, bypassing
      // `remember()`) is served exactly as stored. A record marked encrypted that fails to decrypt
      // (wrong/rotated/missing key, a mismatched aad, or genuine corruption) is DROPPED HERE — never
      // surfaced as ciphertext "garbage", and `crypto.decrypt` never throws, so a bad record can never
      // crash the turn.
      let text = meta.text;
      if (meta.encrypted) {
        const decrypted = await crypto.decrypt(ctx.tenantId, meta.text, aadFor("text"));
        if (decrypted === undefined) { undecryptable++; continue; } // undecryptable — drop the WHOLE record, do not slide its TTL either
        text = decrypted;
      }
      // Security review finding 1 — `disposition.value` decrypts alongside `sourceQuote` now (both are
      // encrypted at write time whenever the fact text is). `value` is a REQUIRED field on `Disposition`
      // (never optional), so an undecryptable `value` drops that WHOLE disposition entry (never a
      // disposition with a missing/garbage value) — unlike `sourceQuote`, which decrypts independently
      // and drops ONLY the quote on failure (the fact's own `text` above already decrypted fine, so the
      // fact itself is still safe and useful to serve without it).
      let disposition = meta.disposition;
      if (meta.encrypted && disposition) {
        const decrypted = await Promise.all(
          disposition.map(async (d): Promise<Disposition | undefined> => {
            const value = await crypto.decrypt(ctx.tenantId, d.value, aadFor("dispositionValue"));
            if (value === undefined) return undefined; // undecryptable value ⇒ drop this disposition entirely
            const sourceQuote = d.sourceQuote ? await crypto.decrypt(ctx.tenantId, d.sourceQuote, aadFor("sourceQuote")) : d.sourceQuote;
            return { ...d, value, sourceQuote };
          }),
        );
        const kept = decrypted.filter((d): d is Disposition => d !== undefined);
        disposition = kept.length > 0 ? kept : undefined;
      }
      // PR-8 — surface the persisted disposition (previously never written, so never read back either).
      facts.push({ text, class: meta.class, disposition });

      // Sliding retention (ADR-0015 Inv 4: "expire … since last activity"; amendment 2026-08-04). The shopper
      // has RETURNED (this recall), so re-stamp the 30-day window from `now` for facts we may still lawfully
      // hold. Consent-gated per tier EXACTLY like the brain's read-time gate (special⇒consent2, ordinary⇒
      // consent1; only literal "in" renews), so a WITHDRAWN/absent-consent fact is NEVER extended — it keeps
      // its expiry and ages out (or is erased). Throttled to at most once per RENEW_MIN_GAP since the last
      // stamp (a same-session burst neither churns the store nor floods the audit log), and only ever FORWARD.
      // B7 (2026-08-05): the SAME `consentPermits` rule the write gate and the brain's read gate use, so
      // a fact that may lawfully be SURFACED this turn is also one whose retention may slide. Previously
      // this demanded a literal "in" in every region, which in the US meant a fact could be written and
      // served but never renewed — three bars where there should be one. Special-category still needs an
      // explicit "in" everywhere. A withdrawn/absent-consent fact is still NEVER extended: it keeps its
      // expiry and ages out.
      const consentIn = consentPermitsFactClass(ctx.region, meta.class, {
        memoryOrdinary: ctx.consent1,
        memorySpecial: ctx.consent2,
      });
      const lastStampedMs = expiresMs !== undefined ? expiresMs - ttlForClass(meta.class) : now;
      if (consentIn && now - lastStampedMs >= RENEW_MIN_GAP_MS) {
        renewed.push({ id: match.id, text: meta.text, metadata: { ...(meta as FactMetadata), expiresAt: new Date(now + ttlForClass(meta.class)).toISOString() } });
      }
    }

    // The retention-EXTENDING write is not silent (ADR-0015 Inv 6): it carries its OWN `ttl_renew` audit
    // (count of facts slid forward), distinct from the read's `recall` audit — whose reversalPath therefore
    // stays truthfully "read-only". So the immutable log shows exactly when, and how many, facts had their
    // retention extended, and by which subject.
    if (renewed.length > 0) {
      await deps.vector.upsert(namespace, renewed);
      await deps.audit.audit(
        { tenantId: ctx.tenantId },
        buildMemoryAudit({ action: "ttl_renew", tenantId: ctx.tenantId, anonId: ctx.anonId, count: renewed.length, hmacKey: deps.hmacKey }),
      );
    }

    if (undecryptable > 0) {
      await deps.audit.audit(
        { tenantId: ctx.tenantId },
        buildMemoryAudit({ action: "recall.dropped", tenantId: ctx.tenantId, anonId: ctx.anonId, count: undecryptable, hmacKey: deps.hmacKey }),
      );
    }

    await deps.audit.audit(
      { tenantId: ctx.tenantId },
      buildMemoryAudit({ action: "recall", tenantId: ctx.tenantId, anonId: ctx.anonId, count: facts.length, hmacKey: deps.hmacKey }),
    );

    return facts;
  }

  return { remember, recall };
}
