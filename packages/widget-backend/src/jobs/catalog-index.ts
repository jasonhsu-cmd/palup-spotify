import { createHash } from "node:crypto";
import {
  canEmbed,
  createEnvSecrets,
  createMeteringModelPort,
  createStoreTelemetry,
  requireEmbedAlignment,
  type GroundingContext,
  type ModelPort,
  type Product,
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
  RUNTIME_AGENT_TYPE,
} from "@palup/state-postgres";
import { parseStoreDomains, resolveShopifyStore } from "../merchant-store.js";
import { createModelPort } from "../model.js";
import {
  createShopifyGroundingAdapter,
  MAX_CATALOG_PRODUCTS,
  STOREFRONT_PAGE_SIZE,
  storefrontFetch,
  type StorefrontFetch,
} from "../shopify-grounding.js";

// C3 — the scheduled/operator-run CATALOG INDEX job: fetch a merchant's catalog, embed it through the
// `model` port, and write one vector per product into the `vector` port under `${tenantId}::catalog`.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// READ THIS FIRST — TWO THINGS ABOUT THIS JOB ARE TRUE AND UNCOMFORTABLE.
//
// 1. NOTHING READS THIS CORPUS. Semantic retrieval over it is a LATER work item, gated behind the
//    evolution pipeline (it changes what the shopper agent grounds on, so it is a run-time behavior
//    change — CLAUDE.md §3.2). Until that lands, a written corpus changes NO shopper-visible behavior.
//    This file does not pretend otherwise and adds no retrieval helper "ready for later".
//
// 2. NO ADAPTER IN THIS REPO CAN EMBED YET. `ModelPort.embed?()` is OPTIONAL (#188) and the only
//    implementations that exist are TEST FAKES — searched all of `packages/` for `async embed`: the hits
//    are platform-ports' own test + fake. The Vertex adapter (`packages/model-vertex`) has no `embed`.
//    So run against the CURRENT deployment this job reports `no-embed-capability` for every tenant,
//    writes nothing, and exits NON-ZERO. That is deliberate: a capability ABSENCE is static and free to
//    detect (`canEmbed`), and an operator who runs an index must be told "this deployment has no
//    embedding adapter" rather than shown a silent success. The job becomes useful the day an embedding
//    adapter lands behind the same port — no change here.
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
 * THE CEILING — the largest catalog this job will index. Pinned to #180's FETCH ceiling
 * (`MAX_CATALOG_PRODUCTS`, 4 pages × 250) so the two can never drift apart, and crossing it makes the
 * job HARD-FAIL for that tenant rather than index part of the catalog.
 *
 * Why hard-fail rather than truncate — the #180 argument, which applies with MORE force on the write
 * side. A truncated corpus does not produce a smaller answer; once retrieval exists it produces a
 * CONFIDENT FALSE one ("we don't carry that") about a product the merchant does carry. And truncation
 * here would be doubly invisible: `PostgresVectorStore.query` already caps its scan at `MAX_SCAN_ROWS`
 * with `ORDER BY id LIMIT` — ID ORDER, NOT RELEVANCE (postgres-vector-store.ts:94) — so a corpus grown
 * past that cap silently loses whichever records sort late by id, with no error anywhere. A refusal, by
 * contrast, is the input every caller here is built for: the merchant keeps whatever complete corpus it
 * already had (or none), and an operator gets a named, actionable outcome.
 *
 * Why not larger: the binding constraint is upstream of this file. `composeSystemPrompt` renders EVERY
 * product of the GroundingContext into EVERY shopper turn with no count cap (#180's finding), so a
 * merchant above this size needs relevance retrieval, not a bigger index — and until retrieval exists,
 * indexing more products than the serving path can carry buys nothing. 1000 also leaves 5× headroom
 * under the 5000-row scan cap, so the corpus is always fully enumerable in one query.
 */
export const MAX_INDEXED_PRODUCTS = MAX_CATALOG_PRODUCTS;

/**
 * `MAX_SCAN_ROWS` from `packages/state-postgres/src/postgres-vector-store.ts:94`, MIRRORED here because
 * that constant is module-private. It is not ours to change (different lane) and the truncation it
 * causes is silent, so `MAX_INDEXED_PRODUCTS` must stay strictly below it — a test reads the real
 * constant out of the real file and fails if this mirror or that relationship ever drifts.
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

/** A refusal this job authored itself: a static, PII-free sentence, reported as `reason`. */
class CatalogRefusal extends Error {
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
 *   4. read the corpus BACK and verify every record landed   → never report an unverified success
 *   5. `deleteById(stale)` for delisted products
 *   6. ONE `store.tx` writing the manifest + its audit record TOGETHER
 *
 * WHAT IS NOT ATOMIC, stated plainly: there is no transaction spanning the vector port and the
 * runtime-state port, so steps 3–6 are not one unit. The order is chosen so every interruption leaves a
 * SUPERSET of a correct corpus, never a hole:
 *   • died after 3, before 5 → the new records are all present, some delisted ones linger. The next run
 *     detects and deletes them (they are just stale ids).
 *   • died after 3, before 6 → the corpus is correct but its manifest is stale and no audit record
 *     exists. The next run notices `manifest.products !== corpus size`, rewrites the manifest and audits
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

  const plan = planProducts(catalog.products);

  // Enumerate the existing corpus. `k` is one MORE than the ceiling: hitting it means the namespace holds
  // more than we could have written, so one query cannot prove what is in there and reconciling stale
  // records would be guesswork (the `enumerateSubjectOrFail` discipline, widget-memory/src/erasure.ts).
  const probe = maxProducts + 1;
  const existing = await deps.vector.query(ns, { text: "", k: probe });
  if (existing.length >= probe) {
    throw new CatalogRefusal(
      "failed",
      `corpus holds at least ${probe} records — one query cannot enumerate it completely, so stale-record ` +
        "reconciliation would be guesswork; clear it (pnpm catalog:clear --tenant <id>) and index again",
    );
  }

  const manifest = await deps.store.get<CatalogManifest>(ctx, MANIFEST_COLLECTION, MANIFEST_KEY);
  if (!manifest && existing.length > 0 && !opts.reindex) {
    // Records with no manifest: a previous run committed vectors and then failed before its manifest +
    // audit. Their {model, dimension} provenance is unknowable, so extending them could mix vector
    // spaces. Only an explicit operator reindex may rebuild.
    throw new CatalogRefusal(
      "failed",
      `corpus has ${existing.length} record(s) but no manifest, so the model/dimension they were built with ` +
        "is unknown — refusing to extend it; rebuild explicitly with --reindex",
    );
  }

  // `--reindex` erases first, so nothing old survives to be mixed with the new pin.
  const priorHashes = new Map<string, string>();
  if (!opts.reindex) {
    for (const m of existing) {
      const h = (m.metadata as { contentHash?: unknown } | undefined)?.contentHash;
      if (typeof h === "string") priorHashes.set(m.id, h);
    }
  }
  const wanted = new Set(plan.map((p) => p.recordId));
  // Reconciliation only ever deletes records THIS JOB WROTE (`product:` ids). A record of any other shape
  // in this namespace is not a delisted product — it is something we do not understand — and deleting data
  // we did not write must never be a side effect of an index run. Refuse loudly instead.
  const foreign = existing.map((m) => m.id).filter((id) => !id.startsWith("product:"));
  if (foreign.length > 0) {
    throw new CatalogRefusal(
      "failed",
      `${foreign.length} record(s) in this namespace were not written by this job (ids do not start with ` +
        '"product:") — refusing to reconcile a corpus it does not own rather than deleting data it did not write',
    );
  }
  const stale = opts.reindex ? [] : existing.map((m) => m.id).filter((id) => !wanted.has(id));
  const toEmbed = plan.filter((p) => priorHashes.get(p.recordId) !== p.hash);

  if (toEmbed.length === 0 && stale.length === 0 && !opts.reindex) {
    // Nothing to do — but only claim "unchanged" if the manifest actually describes this corpus.
    if (manifest && manifest.products === existing.length) {
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
    if (!manifest) {
      // Unreachable in practice (a manifest-less non-empty corpus already refused above, and an empty
      // corpus with an empty catalog returned `not-configured`), but guessing a pin is never acceptable —
      // an "unknown"/0 placeholder would be a fabricated provenance for real vectors.
      throw new CatalogRefusal("failed", "no manifest to repair and no products to embed — nothing safe to record");
    }
    const repaired: CatalogManifest = {
      model: manifest.model,
      dimension: manifest.dimension,
      products: existing.length,
      at: now().toISOString(),
      ceiling: maxProducts,
    };
    await writeManifestAndAudit(deps, tenantId, repaired, {
      products: plan.length,
      embedded: 0,
      written: 0,
      removed: 0,
      reindex: false,
      repaired: true,
    });
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
  let pin: { model: string; dimension: number } | undefined;
  for (let i = 0; i < toEmbed.length; i += batchSize) {
    const stop = await checkHalts(deps, tenantId);
    if (stop) return { tenantId, outcome: stop }; // nothing written yet — the corpus stays fully old
    const batch = toEmbed.slice(i, i + batchSize);
    const texts = batch.map((p) => p.text);
    const res = await deps.model.embed({ texts, tenantId });
    // The caller re-checks the port's own invariant: one vector per text, all of the reported dimension.
    // Cheap, and it means a truncating adapter cannot put a hole in this corpus even if it skipped the
    // shared validator.
    requireEmbedAlignment(texts, res);

    if (!pin) {
      // THE PIN CHECK, on the FIRST batch — so a model/dimension change costs one batch of spend, not a
      // whole catalog. An empty corpus has nothing to mix with, so it simply adopts the current pin.
      if (manifest && existing.length > 0 && !opts.reindex) {
        if (manifest.model !== res.model || manifest.dimension !== res.dimension) {
          return {
            tenantId,
            outcome: "pin-mismatch",
            products: plan.length,
            embedded: texts.length,
            model: res.model,
            dimension: res.dimension,
            reason:
              `corpus is pinned to ${manifest.model}/${manifest.dimension}d but the embedder now reports ` +
              `${res.model}/${res.dimension}d — refusing to mix vector spaces (similarity would be ` +
              "meaningless); rebuild the whole corpus with --reindex when this change is intended",
          };
        }
      }
      pin = { model: res.model, dimension: res.dimension };
    } else if (res.model !== pin.model || res.dimension !== pin.dimension) {
      throw new CatalogRefusal(
        "failed",
        `the embedder changed from ${pin.model}/${pin.dimension}d to ${res.model}/${res.dimension}d mid-run — ` +
          "refusing to write a corpus of two vector spaces",
      );
    }
    batch.forEach((p, j) => vectors.set(p.recordId, res.vectors[j]!));
  }

  // ── write ──
  const records: VectorRecord[] = toEmbed.map((p) => ({
    id: p.recordId,
    vector: vectors.get(p.recordId)!,
    // No `text`, no title, no price: the corpus is a relevance index over product IDS, not a second copy
    // of the catalog (see productEmbedText). Without `text`, `scoreRecord` can only rank these records by
    // cosine, so a text-modality query can never silently match a stale copy of merchant content.
    metadata: { kind: "product", productId: p.productId, contentHash: p.hash },
  }));

  if (opts.reindex) await deps.vector.deleteNamespace(ns);
  if (records.length > 0) await deps.vector.upsert(ns, records); // ONE call = one transaction (durable adapter)

  // READ THE RESULT BACK. `kill-switch.ts`'s discipline: never report a write we have not observed.
  const after = await deps.vector.query(ns, { text: "", k: probe });
  const afterHashes = new Map(
    after.map((m) => [m.id, (m.metadata as { contentHash?: unknown } | undefined)?.contentHash]),
  );
  const missing = records.filter((r) => afterHashes.get(r.id) !== (r.metadata as { contentHash: string }).contentHash);
  if (missing.length > 0) {
    throw new CatalogRefusal(
      "failed",
      `${missing.length} of ${records.length} record(s) did not read back after the write — the corpus is ` +
        "unverified, so no manifest was recorded; re-run the index",
    );
  }

  if (stale.length > 0) await deps.vector.deleteById(ns, stale);

  // A DELETE-ONLY run (a product was delisted and nothing else changed) embeds nothing, so there is no
  // fresh pin to record. Carry the manifest's forward rather than inventing one — the corpus's vectors did
  // not change, so neither may its recorded provenance. `manifest` is guaranteed here: a non-empty corpus
  // without one already refused above, and stale records imply a non-empty corpus.
  const effectivePin = pin ?? (manifest ? { model: manifest.model, dimension: manifest.dimension } : undefined);
  if (!effectivePin) {
    throw new CatalogRefusal(
      "failed",
      "nothing was embedded and no existing pin is recorded, so the corpus's model/dimension cannot be " +
        "stated honestly — refusing to write a manifest",
    );
  }

  const finalCount = opts.reindex ? records.length : wanted.size;
  const written: CatalogManifest = {
    model: effectivePin.model,
    dimension: effectivePin.dimension,
    products: finalCount,
    at: now().toISOString(),
    ceiling: maxProducts,
  };
  await writeManifestAndAudit(deps, tenantId, written, {
    products: plan.length,
    embedded: toEmbed.length,
    written: records.length,
    removed: stale.length,
    reindex: opts.reindex === true,
    repaired: false,
  });

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
): Promise<void> {
  const at = manifest.at;
  await deps.store.tx({ tenantId }, async (t) => {
    await t.put(MANIFEST_COLLECTION, MANIFEST_KEY, manifest);
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

  await deps.store.tx({ tenantId }, async (t) => {
    await t.delete(MANIFEST_COLLECTION, MANIFEST_KEY);
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
 * `createShopifyGroundingAdapter` + `storefrontFetch` are reused verbatim, so the corpus is built from
 * the SAME paginated, whole-catalog-or-nothing fetch the serving path uses (#180) — including its page
 * ceiling and its refusal to return a truncated catalog. The token never leaves the SecretsPort → header
 * path and is never logged (see storefrontFetch's egress log, which has no token field).
 *
 * NOT wrapped in `createCachingGroundingPort` on purpose: an index job wants the CURRENT catalog, not the
 * serving path's cached/stale-while-error view, and it must see a fetch failure as a failure rather than
 * degrade to a stale or safe-empty catalog (which would look like "this merchant delisted everything").
 */
export function shopifyCatalogSource(
  secrets: SecretsPort,
  fetchImpl: StorefrontFetch = storefrontFetch(),
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
  "model change). NOTHING READS THIS CORPUS YET — retrieval is a separate, gated work item.",
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
): Promise<{ store: RuntimeStatePort; vector: VectorPort; kind: string }> {
  if (!env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is unset — refusing to run. Without it this process gets its OWN in-memory stores, so " +
        "the corpus (and its manifest) would vanish when the job exits while the run reported success. " +
        "Point DATABASE_URL at the same Cloud SQL instance the backend uses.",
    );
  }
  const runtime = await createRuntimeStore();
  const vector = await createVectorStore(runtime.sql);
  return { store: runtime.store, vector: vector.store, kind: `${runtime.kind}/${vector.kind}` };
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
    const { store, vector, kind } = await resolveIndexStores();

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

    console.log(
      `[catalog] store=${kind} tenants=${tenantIds.length} ceiling=${MAX_INDEXED_PRODUCTS}` +
        `${cmd.reindex ? " REINDEX (replacing each corpus)" : ""}`,
    );
    const reports = await runCatalogIndex({ store, vector, model, catalog }, tenantIds, {
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
    console.log("[catalog] NOTE: nothing reads this corpus yet — semantic retrieval is a separate, gated work item.");
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
