import { createHash } from "node:crypto";
import {
  canEmbed,
  createEnvSecrets,
  createMeteringModelPort,
  createStoreTelemetry,
  requireEmbedAlignment,
  type EmbedPurpose,
  type GroundingContext,
  type ModelPort,
  type Product,
  type ProductFact,
  type ProductFactsPort,
  type RuntimeStatePort,
  type SecretsPort,
  type VectorPort,
  type VectorRecord,
} from "@palup/platform-ports";
import {
  createRuntimeStore,
  createVectorStore,
  matchedCostCap,
  matchedKill,
  PostgresProductFactsStore,
  RUNTIME_AGENT_TYPE,
  type Sql,
} from "@palup/state-postgres";
import { parseStoreDomains, resolveShopifyStore } from "../merchant-store.js";
import { createModelPort } from "../model.js";
import {
  createShopifyGroundingAdapter,
  MAX_CATALOG_PRODUCTS,
  MAX_INDEX_CATALOG_PAGES,
  STOREFRONT_PAGE_SIZE,
  storefrontFetch,
  type StorefrontFetch,
} from "../shopify-grounding.js";
import {
  chunkLedgerEntries,
  deleteLedgerInTx,
  listLedgerChunkKeys,
  readCorpusLedger,
  writeLedgerInTx,
} from "./catalog-ledger.js";

// C3 — the scheduled/operator-run CATALOG INDEX job: fetch a merchant's catalog, embed it through the
// `model` port, and write one vector per product into the `vector` port under `${tenantId}::catalog`.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// READ THIS FIRST — TWO THINGS ABOUT THIS JOB ARE TRUE AND UNCOMFORTABLE.
//
// 1. NOTHING READS THIS CORPUS IN ANY ENVIRONMENT TODAY — but the path now EXISTS. E1 built the reader
//    (`createCatalogRetriever`, ../catalog-retriever.ts) and `server.ts` now composes it when
//    `CATALOG_RETRIEVAL=true`. That flag is unset everywhere, so a written corpus still changes no
//    shopper-visible behaviour; what changed is that enabling it is now possible to shadow and canary at
//    all, which is what the eval gate, shadow, canary and named-human approval actually require
//    (CLAUDE.md §3.2, HITL-POLICY §5). (Updated by E1, then by the Wave 4 composition change; before E1
//    no reader existed at all.)
//
// 2. THE VERTEX ADAPTER CAN EMBED (#192/B3), so a deployment configured for Vertex no longer reports
//    `no-embed-capability` — this comment said the opposite until E1 corrected it. `ModelPort.embed?()`
//    is still OPTIONAL (#188): an adapter that cannot embed OMITS it, and this job still reports
//    `no-embed-capability` and exits NON-ZERO against such a deployment rather than showing a silent
//    success, because a capability ABSENCE is static and free to detect (`canEmbed`) and an operator who
//    runs an index deserves to be told which of the two it is.
//
// WHY A JOB AND A CLI, not an HTTP route: the argument `retention-sweep.ts` and `kill-switch.ts` already
// make and this inherits verbatim — widget-backend has NO admin authentication, so an admin route would
// mean a new internet-reachable endpoint (plus a new shared secret) for an operation that never needs to
// be reachable from the internet. A Cloud Run Job / CronJob invoking `pnpm catalog:index` needs neither
// and stays portable (ADR-0001) because it goes through the same ports the server uses.
//
// WHY STANDALONE and not "triggered by install": a catalog changes continuously, so an install-time-only
// index is stale the next day — a refresh path is required regardless. `runCatalogIndex` is exported as a
// plain function precisely so an install flow (or a later retrieval PR) can call the SAME code path
// instead of growing a second one. It is not wired into install here: that is another lane's file, and
// with nothing reading the corpus there is no behavior to gain by coupling two in-flight changes.
//
// PORTABILITY: this file knows nothing about Shopify. It consumes a `CatalogSource` returning the
// vendor-neutral `GroundingContext`; the Shopify wiring lives in `shopifyCatalogSource` (composition
// root), so a second commerce platform is a new source function, not a change here (ADR-0001, NN#3).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Reserved namespace suffix for a tenant's catalog corpus. */
export const CATALOG_NAMESPACE_SUFFIX = "catalog";

/**
 * The corpus namespace: `${tenantId}::catalog`, the same Option B scheme widget-memory's
 * `subjectNamespace` uses (`${tenantId}::${anonId}`), so `PostgresVectorStore`'s `tenant_id` column and
 * any future RLS policy derive the right tenant with no special case.
 *
 * IT CANNOT COLLIDE WITH A SUBJECT NAMESPACE: a guest subject id is base32 (`/^[A-Z2-7]{10,64}$/`,
 * identity.ts) and an account subject is `acct:<id>` — neither can be the lowercase literal `catalog`.
 * `::` is rejected inside `tenantId` for the same reason `subjectNamespace` rejects it: otherwise a
 * crafted tenant id could forge a write into another tenant's slot.
 */
export function catalogNamespace(tenantId: string): string {
  if (!tenantId || !tenantId.trim()) throw new Error("catalogNamespace: tenantId must not be blank");
  if (tenantId.includes("::"))
    throw new Error('catalogNamespace: tenantId must not contain "::" (would allow namespace injection)');
  return `${tenantId}::${CATALOG_NAMESPACE_SUFFIX}`;
}

/** Record id for one product's vector. Prefixed so it can never collide with any other record kind. */
export function catalogRecordId(productId: string): string {
  return `product:${productId}`;
}

/**
 * THE INDEX CEILING — the largest catalog this job will index. S2 raised it to the full ADR-0020 ~50k
 * design ceiling: batch embedding (Task 5) makes it tractable, and the serving path no longer renders the
 * whole catalog per turn (it retrieves top-K via getShell), so this is DECOUPLED from serving's own fetch
 * ceiling (`MAX_CATALOG_PRODUCTS`, still 1000). Crossing it HARD-FAILS the tenant rather than indexing a
 * part of it (the #180 truncation argument, unchanged).
 *
 * The brute-force `MAX_SCAN_ROWS` (5000) coupling no longer applies: serving a corpus this size requires
 * `VECTOR_ANN=true` (the S1 pgvector HNSW store), whose query does not do an id-ordered LIMIT scan. On the
 * legacy brute-force store a >5000 corpus WOULD silently truncate at query time — which is exactly why the
 * VECTOR_ANN precondition is documented (S2 spec §D-backend) and must be true before a >5000-SKU store is
 * served. This job does not read `VECTOR_ANN`; it only writes the corpus.
 */
export const MAX_INDEXED_PRODUCTS = 50000;

/**
 * `MAX_SCAN_ROWS` from `packages/state-postgres/src/postgres-vector-store.ts:94`, MIRRORED here because
 * that constant is module-private. It is not ours to change (different lane).
 *
 * S2: the "`MAX_INDEXED_PRODUCTS` must stay below this" invariant is RETIRED — it only ever bounded the
 * legacy brute-force store's silent id-ordered LIMIT truncation, and `MAX_INDEXED_PRODUCTS` (50000) now
 * exceeds it by design. On the S1 pgvector (`VECTOR_ANN=true`) path there is no such scan cap, so serving
 * a corpus above this size is safe ONLY when `VECTOR_ANN=true`; the non-ANN store must never be pointed at
 * a corpus this large (see the ceiling comment above). The constant is kept because other call sites
 * (tests, docs) still read it for that precondition, not to bound the index ceiling anymore.
 */
export const VECTOR_SCAN_ROWS_MIRRORED = 5000;

/** Texts per embed call. One Storefront page's worth, so a full catalog is at most 4 embed calls. */
export const DEFAULT_EMBED_BATCH = STOREFRONT_PAGE_SIZE;

/** Per-tenant KV holding the corpus manifest (the `{model, dimension}` pin + the last confirmed count). */
export const MANIFEST_COLLECTION = "catalog_index";
export const MANIFEST_KEY = "manifest";

/** Audit actor for every write this job makes. Not "operator": the job performs the write. */
export const CATALOG_INDEX_ACTOR = "catalog-index-job";

/**
 * The side of retrieval this job embeds. A CORPUS is always `"document"` — that is what the word means
 * (docs/design/… "you must use different task types for your corpus and your queries", quoted in the
 * Vertex adapter's [E3]). Named rather than inlined so the retriever can assert the corpus it queries was
 * built on the other side of the same pair.
 */
export const CATALOG_CORPUS_PURPOSE: EmbedPurpose = "document";

/**
 * What one tenant's corpus was built with. Lives in the RuntimeStatePort KV, NOT as a vector record, for
 * two reasons: (a) it commits ATOMICALLY WITH ITS AUDIT RECORD in one `store.tx` (NN#5 — the closest to
 * atomic these ports allow, see the write sequence in `indexOneTenant`), and (b) a metadata-only record
 * inside the corpus would score 0 against a vector query — and cosine can be NEGATIVE — so it could
 * outrank a genuinely dissimilar product and leak into a later retrieval's top-K. The corpus contains
 * product vectors only.
 */
export interface CatalogManifest {
  /** Embedding model id reported by the port. The corpus is only extendable at this exact model… */
  model: string;
  /** …and this exact dimension. Mixing either produces silently meaningless similarity (#188). */
  dimension: number;
  /**
   * …and this exact PURPOSE (E1). The third leg of the pin, and the one B3 (#192) said was missing:
   * a corpus embedded with QUERY treatment reports the SAME model and the SAME dimension as a correct
   * one, so `{model, dimension}` alone cannot see it — same shape, wrong space, no downstream symptom.
   * Always `"document"` for a corpus written by this job; recorded rather than assumed so a corpus built
   * by a mis-configured deployment is VISIBLE, and so the retriever can refuse to query across it.
   *
   * A manifest written before E1 has no `purpose` at runtime despite this type. That is treated as a
   * MISMATCH, not as "probably document": the provenance is genuinely unknown, and guessing it is how a
   * silently-wrong corpus gets blessed. `--reindex` is the way through.
   */
  purpose: EmbedPurpose;
  /** Product records the last confirmed write left in the corpus. */
  products: number;
  /** ISO-8601 timestamp of that write. */
  at: string;
  /** The ceiling in force for that write, so a later ceiling change is legible in the record. */
  ceiling: number;
}

export type CatalogIndexOutcome =
  /** Products were embedded and written. */
  | "indexed"
  /** Nothing changed: no embedding call was made and no record was written. */
  | "unchanged"
  /** The corpus was right but its manifest/audit was not — repaired without re-embedding. */
  | "manifest-repaired"
  /** An operator kill was armed for this tenant (or globally/agent-wide). No work was done. */
  | "halted"
  /** This tenant (or the platform) is at its cost cap. No metered work was done. */
  | "capped"
  /** This deployment's model adapter does not declare `embed` — a capability ABSENCE, not a failure. */
  | "no-embed-capability"
  /** The catalog is larger than `MAX_INDEXED_PRODUCTS`. Nothing was written. */
  | "ceiling-exceeded"
  /** The embedder's `{model, dimension}` disagrees with the corpus's pin. Nothing was written. */
  | "pin-mismatch"
  /** No catalog resolved for this tenant (no store configured, or an empty catalog). */
  | "not-configured"
  /** Anything that threw. The corpus is left as it was. */
  | "failed";

export interface TenantIndexReport {
  tenantId: string;
  outcome: CatalogIndexOutcome;
  /** Products in the fetched catalog. */
  products?: number;
  /** Texts actually sent to the embedder (0 on an unchanged re-run — the point of content hashing). */
  embedded?: number;
  /** Records upserted. */
  written?: number;
  /** Stale records (delisted products) removed. */
  removed?: number;
  model?: string;
  dimension?: number;
  /** Error CLASS only, never its message — operator output must stay PII/credential-free (retention.ts's
   *  codified rule; a Storefront failure message could carry a host or token fragment). */
  errorClass?: string;
  /** A STATIC, self-authored explanation for a refusal. Never derived from a caught error's message. */
  reason?: string;
}

/** Resolve one tenant's catalog, or `undefined` when the tenant has no configured store. */
export type CatalogSource = (tenantId: string) => Promise<GroundingContext | undefined>;

export interface CatalogIndexDeps {
  store: RuntimeStatePort;
  vector: VectorPort;
  /** Whatever adapter this deployment composed. `embed` is OPTIONAL — see `canEmbed` below. */
  model: ModelPort;
  catalog: CatalogSource;
  /**
   * A3 (ADR-0020) — OPTIONAL Tier-2 product-facts store. When present, each successful catalog re-fetch
   * ALSO upserts the fresh price/availability facts here (the POLL-path producer, D2 — the freshness win
   * with zero new webhook/queue infra). Absent (the default) ⇒ the job is byte-identical to before: it
   * only indexes the vector corpus and writes nothing here. Fail-safe: a facts-upsert error is logged and
   * the vector index (the primary job) still completes.
   */
  productFacts?: ProductFactsPort;
  now?: () => Date;
}

export interface CatalogIndexOpts {
  /** Replace the corpus wholesale at the embedder's CURRENT pin. The only way past a pin mismatch. */
  reindex?: boolean;
  /** Ceiling override; defaults to `MAX_INDEXED_PRODUCTS`. Injectable so tests exercise it cheaply. */
  maxProducts?: number;
  /** Texts per embed call; defaults to `DEFAULT_EMBED_BATCH`. */
  batchSize?: number;
}

/**
 * The text that gets embedded for one product: title, tags, description — the SEMANTIC fields only.
 *
 * Price and availability are deliberately EXCLUDED. They change constantly (every change would force a
 * paid re-embed of a product whose meaning did not change), they do not carry similarity signal, and
 * keeping them out of the corpus makes a stale price physically unquotable from it — the live
 * GroundingContext stays the single source of truth for anything a shopper is ever told (the #157/#180
 * stale-falsehood lesson). Fields are already length-bounded upstream by `mapStorefrontToContext`.
 */
export function productEmbedText(p: Product): string {
  return [p.title, (p.tags ?? []).join(" "), p.description]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * A3 — project a re-fetched catalog into the Tier-2 money-facts the serving path (A1b) overlays: the
 * VOLATILE fields only (price display string + three-state availability), NOT the semantic ones the
 * vector corpus holds. The mirror image of `productEmbedText`: that excludes price/availability because
 * they change constantly and carry no similarity signal; this carries ONLY them, because they are the
 * money facts a shopper is quoted and must be kept fresh (freshness SLA, D2). `availableForSale` is copied
 * through three-state (absent stays absent — never fabricated). `updatedAt` stamps the poll time so the
 * store can later enforce the D2 staleness ceiling. Pure; the caller supplies `now` (no ambient clock).
 */
export function productFactsFrom(ctx: GroundingContext, now: Date): ProductFact[] {
  const at = now.toISOString();
  return ctx.products.map((p) => ({
    productId: p.id,
    price: p.price,
    ...(p.availableForSale !== undefined ? { availableForSale: p.availableForSale } : {}),
    source: "poll:catalog-index",
    updatedAt: at,
  }));
}

/** sha256 of the embedded text — the change detector that makes a re-run free (see `indexOneTenant`). */
function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

interface PlannedProduct {
  productId: string;
  recordId: string;
  text: string;
  hash: string;
}

/** The three things a corpus is pinned to. Purpose joined `{model, dimension}` in E1 — see the manifest. */
interface CorpusPin {
  model: string;
  dimension: number;
  purpose: EmbedPurpose;
}

/** Operator-readable rendering of a pin: `model/768d/document`. */
function describePin(p: CorpusPin): string {
  return `${p.model}/${p.dimension}d/${p.purpose}`;
}

/**
 * Compare a corpus's recorded pin against what the embedder reports NOW, returning a static, PII-free
 * explanation when they disagree and `undefined` when they match.
 *
 * The purpose leg fails on an ABSENT recorded purpose too (a manifest written before E1). That is
 * deliberate: `undefined` is not evidence of a document corpus, it is an absence of evidence, and the
 * whole point of the pin is to refuse to guess about a vector space.
 */
function pinMismatch(manifest: CatalogManifest, now: CorpusPin): string | undefined {
  if (manifest.model === now.model && manifest.dimension === now.dimension && manifest.purpose === now.purpose)
    return undefined;
  const recorded = manifest.purpose
    ? describePin(manifest)
    : `${manifest.model}/${manifest.dimension}d/(no purpose recorded — this corpus predates the purpose pin)`;
  return (
    `corpus is pinned to ${recorded} but the embedder now reports ${describePin(now)} — refusing to mix ` +
    "vector spaces (similarity would be meaningless, and a corpus embedded for the wrong side of " +
    "retrieval looks exactly like a correct one); rebuild the whole corpus with --reindex when this " +
    "change is intended"
  );
}

/**
 * A refusal this job authored itself: a static, PII-free sentence, reported as `reason`. Exported so
 * `catalog-ledger.ts`'s foreign-guard (readCorpusLedger) can raise the SAME type — a plain `Error` there
 * would only surface as `errorClass` in the report, losing the "which id / which chunk" detail an operator
 * needs (review round-1 FIX 2).
 */
export class CatalogRefusal extends Error {
  constructor(
    readonly outcome: CatalogIndexOutcome,
    message: string,
  ) {
    super(message);
    this.name = "CatalogRefusal";
  }
}

/**
 * Build the per-product plan, failing CLOSED on anything that would put a meaningless or ambiguous
 * record in the corpus.
 */
function planProducts(products: Product[]): PlannedProduct[] {
  const plan: PlannedProduct[] = [];
  const seen = new Set<string>();
  for (const p of products) {
    const text = productEmbedText(p);
    if (!text) {
      // #188 rejects a blank text for the WHOLE batch and leaves the decision here. We refuse the tenant
      // and name the product: skipping it would be a hole in the corpus that looks like data, and once
      // retrieval exists that hole becomes "we don't carry that" about a product the merchant carries.
      // Synthesizing text would be inventing catalog content. A product id is not PII.
      throw new CatalogRefusal(
        "failed",
        `product ${p.id} has no indexable text (title, tags and description are all empty) — refusing the ` +
          "whole catalog rather than storing a meaningless vector or silently skipping the product",
      );
    }
    if (seen.has(p.id)) {
      // Two products with one id would collapse into one record: a silent loss, and an ambiguous corpus.
      throw new CatalogRefusal("failed", `duplicate product id ${p.id} in the catalog — refusing an ambiguous corpus`);
    }
    seen.add(p.id);
    plan.push({ productId: p.id, recordId: catalogRecordId(p.id), text, hash: contentHash(text) });
  }
  return plan;
}

/** Halt/cap re-check, run before EVERY batch of metered work (NN#4: a long loop must honor a halt). */
async function checkHalts(deps: CatalogIndexDeps, tenantId: string): Promise<"halted" | "capped" | null> {
  if (await matchedKill(deps.store, { tenantId, agentType: RUNTIME_AGENT_TYPE })) return "halted";
  // WHY A COST CAP BLOCKS INDEXING. Embedding is metered provider spend through the same choke point as
  // inference (createMeteringModelPort meters `embed`), and a full catalog index is the largest
  // discretionary embedding spend the platform can initiate. Basic-mode-at-cap keeps LIVE CHAT answered
  // and stops everything proactive (cost-cap-registry.ts) — a background batch job is the proactive end
  // of that spectrum, not live chat, so it belongs on the restricted side. And today deferring an index
  // costs a shopper nothing at all, because nothing reads the corpus.
  // THE COUNTER-ARGUMENT, recorded rather than dismissed: once retrieval is live, refusing to index at
  // cap degrades answer quality for the merchant's shoppers, who did not cause the overage. When that
  // day comes the right shape is probably "index the DELTA at cap" (cheap here, thanks to content
  // hashing) or a human decision — not this blanket skip. The operator escape hatch exists today:
  // `pnpm cap:clear --scope tenant:<id>`.
  if (await matchedCostCap(deps.store, { tenantId })) return "capped";
  return null;
}

/**
 * Index ONE tenant. Throws `CatalogRefusal` for a refusal it authored and anything else for a genuine
 * failure; `runCatalogIndex` turns both into a report.
 *
 * THE WRITE SEQUENCE, and what it does and does not guarantee (requirement: never a silent partial
 * corpus). Everything is embedded and held in memory BEFORE anything is written, so:
 *
 *   1. embed every batch (halt/cap re-checked before each)   → a failure here writes NOTHING
 *   2. `deleteNamespace` (only on `--reindex`)               → wholesale replacement
 *   3. ONE `vector.upsert(ns, records)` call                 → all-or-nothing INSIDE the durable
 *      adapter, which runs the whole batch in one transaction (postgres-vector-store.ts:136, verified
 *      against pglite in state-postgres/test/postgres-vector-store.test.ts:135)
 *   4. `deleteById(stale)` for delisted products
 *   5. ONE `store.tx` writing the manifest + the LEDGER (S3 §B) + its audit record TOGETHER
 *
 * S3 §B RETIRED STEP: there used to be a step 4 here — read the corpus BACK via `vector.query(ns,
 * {text:""})` and verify every record landed. That enumerate is GONE (it silently truncated at 5000 rows
 * on the brute-force store and THREW on the S1 pgvector store — the very bug this task closes). The
 * durable adapter's `upsert` is already all-or-nothing in its own transaction, and the ledger written in
 * step 5 (atomically with the manifest) IS the record of what is indexed; a rare upsert/ledger drift
 * self-heals on the next `--reindex`.
 *
 * WHAT IS NOT ATOMIC, stated plainly: there is no transaction spanning the vector port and the
 * runtime-state port, so steps 3–5 are not one unit. The order is chosen so every interruption leaves a
 * SUPERSET of a correct corpus, never a hole:
 *   • died after 3, before 4 → the new records are all present, some delisted ones linger. The next run
 *     detects and deletes them (they are just stale ids per the ledger diff).
 *   • died after 3, before 5 → the corpus is correct but its ledger/manifest are stale and no audit record
 *     exists. The next run notices `manifest.products !== ledger.size`, rewrites the manifest and audits
 *     it WITHOUT re-embedding, and reports `manifest-repaired` — so an unaudited write cannot persist
 *     quietly (NN#5).
 * Mixed dimensions remain impossible throughout: a write happens only when the corpus is EMPTY, when the
 * embedder's pin equals the manifest's, or when `--reindex` has just erased the namespace.
 */
async function indexOneTenant(
  deps: CatalogIndexDeps,
  tenantId: string,
  opts: CatalogIndexOpts,
): Promise<TenantIndexReport> {
  const maxProducts = Math.max(1, Math.floor(opts.maxProducts ?? MAX_INDEXED_PRODUCTS));
  const batchSize = Math.max(1, Math.floor(opts.batchSize ?? DEFAULT_EMBED_BATCH));
  const ns = catalogNamespace(tenantId);
  const ctx = { tenantId };
  const now = deps.now ?? (() => new Date());

  const halted = await checkHalts(deps, tenantId);
  if (halted) return { tenantId, outcome: halted };

  // THE CAPABILITY CHECK, before the catalog is fetched. `canEmbed` is STATIC and free (#188), so there is
  // no reason to spend a Shopify round-trip (or a merchant's API quota) discovering afterwards that this
  // deployment cannot embed. It is checked AFTER the halt/cap read on purpose: an operator who halted a
  // tenant must see `halted`, which is the louder and more actionable fact.
  if (!canEmbed(deps.model)) return { tenantId, outcome: "no-embed-capability" };

  const catalog = await deps.catalog(tenantId);
  if (!catalog || catalog.products.length === 0) return { tenantId, outcome: "not-configured" };

  if (catalog.products.length > maxProducts) {
    // The loud line. Reported, never truncated — see MAX_INDEXED_PRODUCTS.
    return {
      tenantId,
      outcome: "ceiling-exceeded",
      products: catalog.products.length,
      reason:
        `catalog has ${catalog.products.length} products, above this job's ceiling of ${maxProducts} — refusing ` +
        "to index part of it (a truncated corpus becomes a confident false 'we don't carry that')",
    };
  }

  // A3 — POLL-path producer (D2). We now hold a complete, current catalog (ceiling-checked), so refresh the
  // Tier-2 money-facts A1b serves from — on EVERY successful fetch, independent of the vector-corpus diff
  // below (a price/availability change must refresh here even when the semantic text, and so the embedding,
  // is unchanged). Inert when no store is wired. The write is AUDITED (P2, §5) and any failure raises a
  // stably-keyed ALERT marker (P3). FAIL-SAFE: the vector index is the primary job, so a facts write
  // failure is alerted + swallowed rather than failing the tenant's index (the poll re-run is the backstop).
  if (deps.productFacts) {
    const facts = productFactsFrom(catalog, now());
    let upserted = false;
    try {
      await deps.productFacts.upsertMany(tenantId, facts);
      upserted = true;
      // P2 (§5) — LOG the money-fact write to the immutable audit log. It is a separate port from the
      // vector write, so this can't share the manifest's transaction; a rare audit failure AFTER a
      // successful upsert is therefore itself alerted (P3) rather than leaving an unaudited money write.
      await deps.store.audit(
        { tenantId },
        {
          actor: CATALOG_INDEX_ACTOR,
          action: "catalog.product_facts",
          input: { tenantId, count: facts.length, source: "poll:catalog-index" },
          decision: "refreshed", // Tier-2 price/availability facts; served only when PRODUCT_FACTS_HYDRATION is promoted
          reversalPath: `the next \`pnpm catalog:index --tenant ${tenantId}\` run overwrites them; ProductFactsPort.deleteTenant erases them`,
        },
      );
    } catch (e) {
      // P3 — a STABLY-KEYED alert marker so a log-based metric/alert can fire on a silently-failing
      // producer (facts quietly going stale is exactly the risk this makes observable). Non-fatal: the
      // vector index is the primary job and the scheduled poll re-run is the backstop. `upserted`
      // distinguishes an UNWRITTEN refresh (upsert failed) from an UNAUDITED write (facts landed, §5
      // record did not). Configure a Cloud Logging log-based metric/alert on "product_facts_*_failed".
      console.error(
        `[catalog] ALERT product_facts_${upserted ? "audit" : "upsert"}_failed tenant=${tenantId} ` +
          `error=${e instanceof Error ? e.constructor.name : typeof e} msg=${(e as Error).message}`,
      );
    }
  }

  const plan = planProducts(catalog.products);

  // S3 §B — the corpus id→hash set comes from the LEDGER (RuntimeState KV), NOT a vector enumerate. The
  // S2-parked ANN-unsafe vector-store enumerate (a text-modality query with a blank text) is gone: it silently truncated at 5000 on
  // the brute-force store and THREW on the S1 pgvector store, so a >5000-SKU pgvector index could not be
  // reconciled at all. `readCorpusLedger` asserts every id is a `product:` id, so the old foreign-guard is
  // intrinsic — reconcile can only ever `deleteById` ids this job wrote.
  //
  // FIX (review round 1) — `priorChunkKeys` is ALWAYS the real chunk-key set, fetched UNCONDITIONALLY, even
  // on `--reindex`. It feeds `writeLedgerInTx`'s prune list, which is a DIFFERENT concern from the ledger
  // CONTENT used for diffing below: if `--reindex` shrinks a 2-chunk ledger down to 1 chunk, the old
  // `ledger:0001` chunk must still be pruned or it survives as an orphan — the NEXT normal run would then
  // read it, treat its stale ids as still-live-but-removed, and report a false `removed` count for a
  // catalog that never shrank. `--reindex` only resets the CONTENT used to compute new/changed/stale (an
  // empty Map here, so everything re-embeds and `stale` stays empty per the migration-safety rule below) —
  // it must never skip fetching the real prior chunk keys.
  const priorChunkKeys = await listLedgerChunkKeys(deps.store, tenantId);
  const ledger = opts.reindex ? new Map<string, string>() : await readCorpusLedger(deps.store, tenantId);

  const manifest = await deps.store.get<CatalogManifest>(ctx, MANIFEST_COLLECTION, MANIFEST_KEY);

  const wanted = new Set(plan.map((p) => p.recordId));
  // NEW/CHANGED: a plan record whose ledger hash differs (or is absent) must be re-embedded. UNCHANGED: a
  // ledger hash equal to the plan hash is skipped — preserving the content-hash "free re-run" optimization.
  const toEmbed = plan.filter((p) => ledger.get(p.recordId) !== p.hash);
  // STALE: ledger ids no longer in the plan (delisted). MIGRATION SAFETY: an empty ledger (first S3 run, or
  // a corpus built pre-S3) means the prior set is UNKNOWN, so nothing is deleted — build the ledger from the
  // plan and let a later `--reindex` prune legacy orphans (spec §B "Migration"). `--reindex` erased the
  // namespace above, so its stale set is also empty.
  const stale = opts.reindex || ledger.size === 0 ? [] : [...ledger.keys()].filter((id) => !wanted.has(id));

  if (toEmbed.length === 0 && stale.length === 0 && !opts.reindex) {
    // Nothing to do. The ledger is authoritative and committed atomically with the manifest, so a manifest
    // whose count matches the ledger size describes this corpus exactly.
    if (manifest && manifest.purpose && manifest.products === ledger.size) {
      return {
        tenantId,
        outcome: "unchanged",
        products: plan.length,
        embedded: 0,
        written: 0,
        removed: 0,
        model: manifest.model,
        dimension: manifest.dimension,
      };
    }
    // Manifest count drifted from the ledger (e.g. a crash between the corpus write and the manifest write
    // in a pre-S3 record) — repair the COUNT without re-embedding, carrying provenance forward verbatim. A
    // manifest with no recorded purpose cannot be repaired into one (that would invent provenance).
    if (!manifest || !manifest.purpose) {
      throw new CatalogRefusal(
        "failed",
        "the corpus has no manifest purpose to carry forward and nothing to embed, so its vector space " +
          "cannot be stated honestly — rebuild explicitly with --reindex",
      );
    }
    const repaired: CatalogManifest = {
      model: manifest.model,
      dimension: manifest.dimension,
      purpose: manifest.purpose,
      products: ledger.size,
      at: now().toISOString(),
      ceiling: maxProducts,
    };
    await writeManifestAndAudit(
      deps,
      tenantId,
      repaired,
      { products: plan.length, embedded: 0, written: 0, removed: 0, reindex: false, repaired: true },
      { entries: ledger, priorChunkKeys },
    );
    return {
      tenantId,
      outcome: "manifest-repaired",
      products: plan.length,
      embedded: 0,
      written: 0,
      removed: 0,
      model: repaired.model,
      dimension: repaired.dimension,
    };
  }

  // ── embed everything first; write nothing until every batch is in hand ──
  const vectors = new Map<string, number[]>();
  let pin: CorpusPin | undefined;
  for (let i = 0; i < toEmbed.length; i += batchSize) {
    const stop = await checkHalts(deps, tenantId);
    if (stop) return { tenantId, outcome: stop }; // nothing written yet — the corpus stays fully old
    const batch = toEmbed.slice(i, i + batchSize);
    const texts = batch.map((p) => p.text);
    const req = { texts, purpose: CATALOG_CORPUS_PURPOSE, tenantId };
    const res = await deps.model.embed(req);
    // The caller re-checks the port's own invariant: one vector per text, all of the reported dimension,
    // and the purpose echoed. Cheap, and it means a truncating adapter — or one that quietly embedded the
    // corpus on the QUERY side — cannot put a hole (or a wrong-space vector) in this corpus even if it
    // skipped the shared validator.
    requireEmbedAlignment(req, res);

    if (!pin) {
      // THE PIN CHECK, on the FIRST batch — so a model/dimension/purpose change costs one batch of spend,
      // not a whole catalog. An empty corpus has nothing to mix with, so it simply adopts the current pin.
      if (manifest && ledger.size > 0 && !opts.reindex) {
        const mismatch = pinMismatch(manifest, res);
        if (mismatch) {
          return {
            tenantId,
            outcome: "pin-mismatch",
            products: plan.length,
            embedded: texts.length,
            model: res.model,
            dimension: res.dimension,
            reason: mismatch,
          };
        }
      }
      pin = { model: res.model, dimension: res.dimension, purpose: res.purpose };
    } else if (res.model !== pin.model || res.dimension !== pin.dimension || res.purpose !== pin.purpose) {
      throw new CatalogRefusal(
        "failed",
        `the embedder changed from ${describePin(pin)} to ${describePin(res)} mid-run — ` +
          "refusing to write a corpus of two vector spaces",
      );
    }
    batch.forEach((p, j) => vectors.set(p.recordId, res.vectors[j]!));
  }

  // ── write ──
  // S2 (serving-unlock, Task 1): the corpus metadata carries the STABLE render fields — `title` and
  // `variantId` — so a later retriever can build a shopper-facing product card without a second fetch of
  // the whole catalog. Price/availability stay OUT (unchanged money/NN#1 invariant — those live in
  // ProductFactsPort and are re-confirmed at serve time, never read from this corpus). No `text` is
  // stored: the corpus is still a relevance index over product IDs, not a second copy of the catalog (see
  // productEmbedText). Without `text`, `scoreRecord` can only rank these records by cosine, so a
  // text-modality query can never silently match a stale copy of merchant content.
  const byId = new Map(catalog.products.map((p) => [p.id, p]));
  const records: VectorRecord[] = toEmbed.map((p) => {
    const src = byId.get(p.productId);
    // Only the COMBINED embed text (title+tags+description) is guaranteed non-empty by planProducts (a
    // product where all three are empty already refused the whole catalog upstream) — `title` ALONE can
    // still be empty (e.g. an untitled product with only tags/description). Such a row gets `title: ""` in
    // metadata here, on purpose, rather than being dropped at index time: the drop happens at RENDER time
    // instead, where `retrieveViaShell` (brain.ts) treats a hit with no render title as unusable and skips
    // it rather than render a blank card. `variantId` is OPTIONAL on `Product` (grounding-port.ts) — absent
    // when the source reports no purchasable variant — and is carried only when present so the metadata
    // never stores a literal `undefined`.
    return {
      id: p.recordId,
      vector: vectors.get(p.recordId)!,
      metadata: {
        kind: "product",
        productId: p.productId,
        contentHash: p.hash,
        title: src?.title ?? "",
        ...(src?.variantId ? { variantId: src.variantId } : {}),
      },
    };
  });

  if (opts.reindex) await deps.vector.deleteNamespace(ns);
  if (records.length > 0) await deps.vector.upsert(ns, records); // ONE call = one transaction (durable adapter)

  // NO READ-BACK ENUMERATE (S3 §B). The old text-modality read-back query is gone — it required the
  // text-modality enumerate the S1 pgvector store rejects. `upsert` is all-or-nothing inside the durable
  // adapter's single transaction (postgres-vector-store.ts), and the LEDGER we write below (atomically with
  // the manifest + audit) is the record of what is indexed. A rare upsert/ledger drift self-heals on the
  // next `--reindex` (which erases + rebuilds from scratch).

  if (stale.length > 0) await deps.vector.deleteById(ns, stale);

  // A DELETE-ONLY run (a product was delisted and nothing else changed) embeds nothing, so there is no
  // fresh pin to record. Carry the manifest's forward rather than inventing one — the corpus's vectors did
  // not change, so neither may its recorded provenance. `manifest` is guaranteed here: a non-empty corpus
  // without one already refused above, and stale records imply a non-empty corpus.
  const effectivePin: CorpusPin | undefined =
    pin ??
    (manifest && manifest.purpose
      ? { model: manifest.model, dimension: manifest.dimension, purpose: manifest.purpose }
      : undefined);
  if (!effectivePin) {
    throw new CatalogRefusal(
      "failed",
      "nothing was embedded and no complete pin is recorded, so the corpus's model/dimension/purpose " +
        "cannot be stated honestly — refusing to write a manifest",
    );
  }

  const finalCount = opts.reindex ? records.length : wanted.size;
  const written: CatalogManifest = {
    model: effectivePin.model,
    dimension: effectivePin.dimension,
    purpose: effectivePin.purpose,
    products: finalCount,
    at: now().toISOString(),
    ceiling: maxProducts,
  };
  // The new ledger reflects the WHOLE corpus (plan == wanted): unchanged records keep their hash, changed
  // ones get the new hash, stale ones are dropped. On --reindex the corpus is exactly the plan too.
  const newLedger = new Map(plan.map((p) => [p.recordId, p.hash]));
  await writeManifestAndAudit(
    deps,
    tenantId,
    written,
    {
      products: plan.length,
      embedded: toEmbed.length,
      written: records.length,
      removed: stale.length,
      reindex: opts.reindex === true,
      repaired: false,
    },
    { entries: newLedger, priorChunkKeys },
  );

  return {
    tenantId,
    outcome: "indexed",
    products: plan.length,
    embedded: toEmbed.length,
    written: records.length,
    removed: stale.length,
    model: written.model,
    dimension: written.dimension,
  };
}

/**
 * Manifest + audit in ONE transaction (NN#5 "atomically where the ports allow"). The audit's
 * `reversalPath` names `pnpm catalog:clear`, a CLI in THIS package that an operator can actually run
 * against the deployment that exists — `deploy-staging.yml` deploys only `palup-widget-staging` and no
 * workflow deploys the control plane, which is exactly the defect #179 (and #166 before it) had to fix
 * when a reversal path named an unreachable HTTP route. A test feeds this string back through
 * `parseCatalogArgv` so it cannot rot into a command that does not exist.
 */
async function writeManifestAndAudit(
  deps: CatalogIndexDeps,
  tenantId: string,
  manifest: CatalogManifest,
  counts: { products: number; embedded: number; written: number; removed: number; reindex: boolean; repaired: boolean },
  ledger: { entries: Map<string, string>; priorChunkKeys: string[] },
): Promise<void> {
  const at = manifest.at;
  await deps.store.tx({ tenantId }, async (t) => {
    await t.put(MANIFEST_COLLECTION, MANIFEST_KEY, manifest);
    // S3 §B — the ledger commits ATOMICALLY with the manifest + audit (one tx), so the three can never
    // disagree about what is indexed. Prunes any prior chunk key the new corpus no longer fills.
    await writeLedgerInTx(t, chunkLedgerEntries(ledger.entries, at), ledger.priorChunkKeys);
    await t.audit(
      {
        actor: CATALOG_INDEX_ACTOR,
        action: "catalog.index",
        input: {
          tenantId,
          products: counts.products,
          embedded: counts.embedded,
          written: counts.written,
          removed: counts.removed,
          model: manifest.model,
          dimension: manifest.dimension,
          purpose: manifest.purpose,
          ceiling: manifest.ceiling,
          reindex: counts.reindex,
        },
        decision: counts.repaired ? "manifest_repaired" : counts.reindex ? "corpus_replaced" : "corpus_updated",
        reversalPath: `pnpm catalog:clear --tenant ${tenantId}`,
      },
      at,
    );
  });
}

/**
 * Index every listed tenant. Returns one report per tenant rather than throwing, so a scheduler sees a
 * complete picture of a partially-successful run instead of only its first failure (retention-sweep.ts's
 * contract, for the same reason).
 */
export async function runCatalogIndex(
  deps: CatalogIndexDeps,
  tenantIds: string[],
  opts: CatalogIndexOpts = {},
): Promise<TenantIndexReport[]> {
  const reports: TenantIndexReport[] = [];
  for (const tenantId of tenantIds) {
    try {
      reports.push(await indexOneTenant(deps, tenantId, opts));
    } catch (e) {
      if (e instanceof CatalogRefusal) {
        reports.push({ tenantId, outcome: e.outcome, reason: e.message });
      } else {
        // Class only, never the message: a Storefront/provider error can carry a host or credential
        // fragment, and this string reaches operator logs.
        reports.push({ tenantId, outcome: "failed", errorClass: e instanceof Error ? e.constructor.name : typeof e });
      }
    }
  }
  return reports;
}

export interface CatalogClearReport {
  tenantId: string;
  /** Records that were in the corpus before the erase. */
  removed: number;
  /** True only when the namespace READ BACK empty. `runCatalogClear` throws instead of returning false. */
  confirmed: boolean;
  elapsedMs: number;
}

/**
 * THE REVERSAL. Erases one tenant's catalog corpus and its manifest, confirms the erasure by re-reading,
 * and audits it. Scoped to `${tenantId}::catalog` only: another tenant's corpus and this tenant's SHOPPER
 * MEMORY (`${tenantId}::<subjectId>`) are different namespaces and are untouched.
 */
export async function runCatalogClear(
  deps: { store: RuntimeStatePort; vector: VectorPort; now?: () => Date },
  tenantId: string,
): Promise<CatalogClearReport> {
  const ns = catalogNamespace(tenantId);
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const started = Date.now();

  const before = await deps.vector.query(ns, { text: "", k: MAX_INDEXED_PRODUCTS + 1 });
  await deps.vector.deleteNamespace(ns);
  const after = await deps.vector.query(ns, { text: "", k: 1 });
  if (after.length > 0) {
    throw new Error(`clear of ${tenantId}'s catalog corpus did not take effect — records are still readable`);
  }

  // S3 §F — the ledger is per-tenant KV; erasing the corpus must also erase its ledger chunks (ADR-0015).
  // Read the chunk keys before the tx (the tx handle has no `list`), delete them inside it.
  const ledgerChunkKeys = await listLedgerChunkKeys(deps.store, tenantId);
  await deps.store.tx({ tenantId }, async (t) => {
    await t.delete(MANIFEST_COLLECTION, MANIFEST_KEY);
    await deleteLedgerInTx(t, ledgerChunkKeys);
    await t.audit(
      {
        actor: "operator",
        action: "catalog.clear",
        input: { tenantId, removed: before.length },
        decision: "corpus_erased",
        // Honest about what "reverse" means here: re-indexing rebuilds from the merchant's CURRENT
        // catalog. It does not restore the exact vectors this clear removed.
        reversalPath: `pnpm catalog:index --tenant ${tenantId} (rebuilds from the current catalog; it does not restore these vectors)`,
      },
      at,
    );
  });

  return { tenantId, removed: before.length, confirmed: true, elapsedMs: Date.now() - started };
}

/**
 * Tenants to index: the merchants this deployment has a STORE DOMAIN for (`SHOPIFY_STORES` — the same
 * env the server resolves storefronts from). Deliberately NOT `SWEEP_TENANTS`: that env lists extra
 * DELETION targets for the retention sweep, and a tenant with no configured store has no catalog to
 * index, so honoring it here would only produce `not-configured` noise.
 */
export function tenantsToIndex(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(parseStoreDomains(env.SHOPIFY_STORES));
}

/**
 * Shopify wiring (composition root). Returns the vendor-neutral `GroundingContext` or `undefined` when
 * the tenant is not fully configured (no domain, or no token in the SecretsPort) — never a fixture
 * catalog: indexing demo products as if they were a merchant's would be exactly the falsehood the
 * commerce-fixture marker exists to prevent.
 *
 * `createShopifyGroundingAdapter` + `storefrontFetch` are reused verbatim (same pagination, whole-catalog-
 * or-nothing behavior, and refusal semantics as the serving path, #180) — but the DEFAULT `fetchImpl` here
 * is deep: `maxPages: MAX_INDEX_CATALOG_PAGES` (200), not serving's 4-page cap, so the index job can page
 * the whole `MAX_INDEXED_PRODUCTS` (50000) ceiling. Serving's own `getContext` (model.ts) keeps its own
 * `storefrontFetch()` default (4 pages / 1000 products) untouched — this default only applies here. The
 * token never leaves the SecretsPort → header path and is never logged (see storefrontFetch's egress log,
 * which has no token field).
 *
 * NOT wrapped in `createCachingGroundingPort` on purpose: an index job wants the CURRENT catalog, not the
 * serving path's cached/stale-while-error view, and it must see a fetch failure as a failure rather than
 * degrade to a stale or safe-empty catalog (which would look like "this merchant delisted everything").
 */
export function shopifyCatalogSource(
  secrets: SecretsPort,
  fetchImpl: StorefrontFetch = storefrontFetch(globalThis.fetch, { maxPages: MAX_INDEX_CATALOG_PAGES }),
  domains: Record<string, string> = parseStoreDomains(),
): CatalogSource {
  return async (tenantId) => {
    const creds = await resolveShopifyStore(tenantId, secrets, domains);
    if (!creds) return undefined;
    return createShopifyGroundingAdapter(creds, fetchImpl).getContext(tenantId);
  };
}

// ── operator CLI ───────────────────────────────────────────────────────────────────────────────────

export type CatalogAction = "index" | "clear";

export interface CatalogCommand {
  action: CatalogAction;
  /** Required for `clear`. Optional for `index` (absent = every configured tenant). */
  tenantId?: string;
  reindex?: boolean;
}

export class CatalogArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogArgsError";
  }
}

export const CATALOG_USAGE = [
  "usage:",
  "  pnpm catalog:index [--tenant ID] [--reindex]   index every configured tenant, or one",
  "  pnpm catalog:clear  --tenant ID                erase one tenant's catalog corpus",
  "",
  "DATABASE_URL must point at the SAME store the deployed backend uses, or the corpus is written to a",
  "per-process store that dies with this process. --reindex REPLACES a corpus (use it after an embedding",
  "model or PURPOSE change). NOTHING READS THIS CORPUS ON A LIVE PATH: the retriever exists (E1) and the",
  "server composes it, but its CATALOG_RETRIEVAL flag is off by default and human-promotion-gated.",
].join("\n");

/** Split `--flag=value`; a bare `--flag` yields no inline value. */
function splitFlag(arg: string): { flag: string; inline?: string } {
  const eq = arg.indexOf("=");
  return eq === -1 ? { flag: arg } : { flag: arg.slice(0, eq), inline: arg.slice(eq + 1) };
}

/**
 * Parse `[index|clear] [--tenant ID] [--reindex]`. Throws on ANYTHING ambiguous — including an
 * unrecognized flag, so a mistyped `--tenat=acme` can never be silently dropped and turn a one-tenant
 * run into a whole-fleet one (`kill-switch.ts`'s parser rule, same reasoning).
 *
 * ASYMMETRY, deliberate: `index` with no `--tenant` runs every configured tenant (that is what a
 * scheduled refresh IS, and indexing is additive + reversible), while `clear` REQUIRES an explicit
 * `--tenant` and has no `all` — a forgotten flag must never erase every merchant's corpus.
 */
export function parseCatalogArgv(argv: string[]): CatalogCommand {
  const [action, ...rest] = argv;
  if (action !== "index" && action !== "clear") {
    throw new CatalogArgsError(
      action ? `unknown subcommand "${action}" — expected index or clear` : "no subcommand — expected index or clear",
    );
  }

  let tenantId: string | undefined;
  let reindex = false;
  for (let i = 0; i < rest.length; i++) {
    const { flag, inline } = splitFlag(rest[i]!);
    if (flag === "--reindex") {
      if (inline !== undefined) throw new CatalogArgsError("--reindex takes no value");
      reindex = true;
      continue;
    }
    if (flag !== "--tenant") throw new CatalogArgsError(`unknown argument "${rest[i]}"`);
    let value = inline;
    if (value === undefined) {
      const next = rest[i + 1];
      // A value taken from the next slot must not itself be a flag: `--tenant --reindex` is a forgotten
      // value, not a tenant named "--reindex".
      if (next === undefined || next.startsWith("--")) throw new CatalogArgsError("--tenant requires a value");
      value = next;
      i++;
    }
    if (!value.trim()) throw new CatalogArgsError("--tenant requires a value");
    tenantId = value.trim();
  }

  if (action === "clear") {
    if (reindex) throw new CatalogArgsError("--reindex is not a clear option (clear only erases)");
    if (!tenantId) throw new CatalogArgsError("clear requires --tenant <id> — there is no default and no --tenant all");
    if (tenantId === "all")
      throw new CatalogArgsError('--tenant all does not exist — name one tenant; clearing every corpus is not one command');
    return { action, tenantId };
  }
  return { action, ...(tenantId === undefined ? {} : { tenantId }), ...(reindex ? { reindex: true } : {}) };
}

/**
 * The stores this job is allowed to write: the SHARED, durable ones. `createRuntimeStore()` /
 * `createVectorStore()` fall back to PER-PROCESS in-memory stores when `DATABASE_URL` is unset — a fine
 * dev default for the server, and the worst possible outcome here: the job would report a corpus that
 * exists only inside a process that is about to exit. Same guard, same reason as
 * `kill-switch.ts`'s `resolveKillStore`; the message differs because the consequence does.
 *
 * `env` is the guard's input only — the factories read `process.env` themselves (one source of truth for
 * the connection string), so passing a synthetic env cannot redirect which store is opened. The runtime
 * store's `sql` is threaded into the vector store so this process opens exactly ONE `pg.Pool`.
 */
export async function resolveIndexStores(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ store: RuntimeStatePort; vector: VectorPort; sql: Sql | undefined; kind: string }> {
  if (!env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is unset — refusing to run. Without it this process gets its OWN in-memory stores, so " +
        "the corpus (and its manifest) would vanish when the job exits while the run reported success. " +
        "Point DATABASE_URL at the same Cloud SQL instance the backend uses.",
    );
  }
  const runtime = await createRuntimeStore();
  const vector = await createVectorStore(runtime.sql);
  // A3 — `sql` exposed so main() can build the durable Tier-2 product-facts store on the SAME pool.
  return { store: runtime.store, vector: vector.store, sql: runtime.sql, kind: `${runtime.kind}/${vector.kind}` };
}

async function main(): Promise<void> {
  let cmd: CatalogCommand;
  try {
    cmd = parseCatalogArgv(process.argv.slice(2));
  } catch (e) {
    console.error(`[catalog] ${(e as Error).message}\n\n${CATALOG_USAGE}`);
    process.exitCode = 2;
    return;
  }

  try {
    const { store, vector, sql, kind } = await resolveIndexStores();

    if (cmd.action === "clear") {
      const report = await runCatalogClear({ store, vector }, cmd.tenantId!);
      console.log(
        `[catalog] CLEARED tenant=${report.tenantId} removed=${report.removed} — CONFIRMED in ${report.elapsedMs}ms (store=${kind})`,
      );
      console.log(`[catalog] reverse with: pnpm catalog:index --tenant ${report.tenantId}`);
      return;
    }

    const tenantIds = cmd.tenantId ? [cmd.tenantId] : tenantsToIndex();
    if (tenantIds.length === 0) {
      console.error("[catalog] no tenants configured (set SHOPIFY_STORES, or pass --tenant) — nothing to do");
      process.exitCode = 1;
      return;
    }

    // Metering wraps the model port so embedding spend lands in the SAME cost meter as inference, tagged
    // `catalog-index` for attribution (ADR-0013). `createModelPort()` already applies PII redaction.
    const telemetry = createStoreTelemetry(store);
    const model = createMeteringModelPort(createModelPort().port, telemetry, { agentType: "catalog-index" });
    const catalog = shopifyCatalogSource(createEnvSecrets());

    // A3 — the POLL-path Tier-2 producer, behind PRODUCT_FACTS_POLL (default OFF, governed like every
    // posture flag). ON ⇒ each catalog re-fetch also upserts fresh price/availability into the durable
    // product-facts store the serving path (A1b) overlays from. OFF ⇒ the job writes nothing there and is
    // byte-identical to before. Postgres-only here (the job already refuses to run without DATABASE_URL).
    const PRODUCT_FACTS_POLL = process.env.PRODUCT_FACTS_POLL === "true";
    const productFacts = PRODUCT_FACTS_POLL && sql ? new PostgresProductFactsStore(sql) : undefined;
    if (productFacts) await productFacts.migrate();
    if (PRODUCT_FACTS_POLL) {
      console.warn(
        "[config] PRODUCT_FACTS_POLL is ON — this job now also writes the Tier-2 product-facts store the " +
          "serving path reads. Enabling the SERVING side (PRODUCT_FACTS_HYDRATION) to quote those facts is a " +
          "separate money/NN#1 promotion (HITL-POLICY §5).",
      );
    }

    console.log(
      `[catalog] store=${kind} tenants=${tenantIds.length} ceiling=${MAX_INDEXED_PRODUCTS}` +
        `${cmd.reindex ? " REINDEX (replacing each corpus)" : ""}${productFacts ? " +product-facts" : ""}`,
    );
    const reports = await runCatalogIndex({ store, vector, model, catalog, ...(productFacts ? { productFacts } : {}) }, tenantIds, {
      ...(cmd.reindex ? { reindex: true } : {}),
    });

    for (const r of reports) {
      const detail =
        r.outcome === "indexed" || r.outcome === "unchanged" || r.outcome === "manifest-repaired"
          ? ` products=${r.products} embedded=${r.embedded} written=${r.written} removed=${r.removed} model=${r.model} dim=${r.dimension}`
          : "";
      const line = `[catalog] tenant=${r.tenantId} ${r.outcome.toUpperCase()}${detail}`;
      if (NEEDS_A_HUMAN.has(r.outcome)) console.error(`${line}${r.reason ? ` — ${r.reason}` : ""}${r.errorClass ? ` error=${r.errorClass}` : ""}`);
      else console.log(line);
    }

    if (reports.some((r) => NEEDS_A_HUMAN.has(r.outcome))) process.exitCode = 1;
    if (reports.some((r) => r.outcome === "no-embed-capability")) {
      console.error(
        "[catalog] this deployment's model adapter does not implement ModelPort.embed — NO corpus was written. " +
          "That is a missing capability, not a failed call: an embedding adapter has to land behind the model " +
          "port before this job can do anything.",
      );
    }
    console.log(
      "[catalog] NOTE: nothing reads this corpus on a live path by default. The retriever exists (E1) and " +
        "the server composes it when CATALOG_RETRIEVAL is set, but that flag is off by default — enabling it " +
        "is a governed human promotion step (eval gate → shadow → canary → named-human approval, HITL-POLICY §5), " +
        "not a routine deploy toggle.",
    );
  } catch (e) {
    console.error(`[catalog] FAILED: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

/** Outcomes a scheduler must surface as unhealthy: the operator asked for an index and did not get one. */
const NEEDS_A_HUMAN = new Set<CatalogIndexOutcome>([
  "failed",
  "pin-mismatch",
  "ceiling-exceeded",
  "no-embed-capability",
]);

// Run only when invoked directly (`pnpm catalog:index`), never on import — the test imports this module.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
