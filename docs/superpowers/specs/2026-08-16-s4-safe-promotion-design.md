# S4 — safe promotion (A2 / ADR-0020) — design

**Status:** Draft for review — 2026-08-16. Author: build agent (brainstormed with jason.hsu).
**Governs:** the final A2 sub-project — the controls + evidence that let `CATALOG_RETRIEVAL` be promoted to
real shoppers safely, one merchant at a time. Builds the two compensating controls PR #295's canary-waiver
assumes but that do NOT exist today (per-tenant staged enablement + a retrieval-scoped kill), points
eval/shadow at pgvector-scale with recorded evidence, and closes the S3-surfaced §5 preconditions.
**Builds on:** S1 (pgvector engine #297), S2 (serving-unlock #299), S3 (freshness #300).
**Ships dark.** No serving/governance flag is flipped by any S4 code. Enablement + kill are set via audited
`pnpm` CLIs against Cloud SQL (control-plane is deployed nowhere — CLI+DB is the working path). **Enabling a
tenant remains a HITL-POLICY §5 named-owner promotion.** S4 is **governance-touching → human-merged by
jason.hsu.**

---

## 1. Problem (verified 2026-08-16 via source map)

1. **`CATALOG_RETRIEVAL` is process-global.** One boot-time `process.env.CATALOG_RETRIEVAL === "true"`
   (`server.ts:586`) threaded identically to every tenant's brain (`server.ts:680-694` →
   `brain.ts:1027`). There is no per-tenant dimension — enabling it is all-tenants-or-none, contradicting
   #295's "per tenant, staged, one merchant at a time, never global" control.
2. **No retrieval-scoped kill is READ.** The kill registry's scope enum already permits `agent:${string}`
   and `pnpm kill:arm --scope agent:catalog-retrieval` parses (`kill-switch.ts:110-120`), but `/chat` only
   ever reads `matchedKill(..., {agentType:"shopper"})` (`server.ts:2276`-area), which halts the WHOLE turn
   (`brain.ts:1122`). An `agent:catalog-retrieval` kill armed today is inert — nothing reads it, and there
   is no retrieval-only degrade.
3. **eval/shadow run in-memory at demo scale.** `eval:retrieval` (`eval-retrieval.ts`) and `shadow:retrieval`
   (`packages/eval/src/shadow-retrieval.ts`) use real Vertex but build the vector store IN-MEMORY via
   `buildIndexedRetriever` (`retrieval-eval.ts:37-56`, `InMemoryRuntimeStore`/`createInMemoryVectorStore`)
   over a ~13-product corpus. Neither writes a structured evidence artifact. So the §5 "recorded eval+shadow
   on a scale-representative corpus" evidence cannot be produced against the real pgvector engine today.
4. **#295 is BLOCK-UNTIL.** Its canary waiver rests on the two controls in (1)+(2), which don't exist; its
   "1000-product ceiling" caveat is now stale (S3 raised `MAX_INDEXED_PRODUCTS` to 50000; serving-fetch stays
   1000; >5000 needs `VECTOR_ANN`).
5. **S3-surfaced §5 preconditions remain open:** `shop/redact`/`app/uninstalled` don't erase the catalog
   corpus or ledger; `runCatalogClear` text-enumerates (`catalog-index.ts:1040,1042`) → throws on pgvector;
   the hourly backstop can race a concurrent webhook reconcile.

**Working precedents to mirror:** `autopromote-optin.ts` (per-tenant KV opt-in + `__system__` platform
master on `RuntimeStatePort`, both default OFF, server-sourced, audited — the READ shape); `kill:arm` /
`cap:set` CLIs writing to the same Cloud SQL `RuntimeStatePort` in a `store.tx` with an atomic audit row (the
WRITE path that actually runs in staging); `matchedKill` precedence global>tenant>agent.

## 2. Decisions (settled with jason.hsu, 2026-08-16)

- **D-S4-enable — master + per-tenant KV, retire the env.** Two `RuntimeStatePort` gates, both default OFF: a
  platform-master switch (`__system__`) AND a per-tenant opt-in; retrieval is enabled for a tenant iff BOTH
  are on. Set via a new audited `pnpm catalog:enable` CLI. The global `process.env.CATALOG_RETRIEVAL` env
  flag is **retired**. (§B)
- **D-S4-kill — retrieval kill degrades to full-catalog.** An armed `agent:catalog-retrieval` kill forces
  `catalogRetrievalEnabled=false` for the turn; the brain takes its existing full-catalog `getContext` path
  (graceful for ≤1000-SKU; a >1000 store degrades to the safe-empty reply — acceptable, retrieval is what let
  it render and it's been killed). NOT a turn halt. (§C)
- **D-S4-evidence — harness runs on pgvector; the real-Vertex-at-scale run is the operator's §5 step.** CI/
  testcontainer proves the wiring + artifact shape on the mock/pgvector path; the recorded real-Vertex
  evidence is produced by the operator via a runbook (CI has no real Vertex). (§D)
- **D-S4-concurrency — portable fetch-timestamp guard** (over a pg advisory lock, which would be vendor SQL
  behind a new port): the full reconcile records its catalog-fetch start; it skips stale-deleting any ledger
  entry written after that snapshot. (§F)
- **D-S4-295 — S4 carries the corrected amendment; #295 is superseded.** S4 makes the HITL-POLICY §5 +
  ADR-0020 amendment itself (the controls now exist), and recommends closing #295. (§E)

**Non-goals:** flipping any flag / enabling any tenant (that is the §5 human step); the Approval Center
console / control-plane deployment; `INVENTORY_LEVELS_UPDATE`→product precise mapping; tenant-list-from-
registry for the scheduled job (still an S4-or-later ops item, documented, not built here).

---

## §B — Per-tenant enablement (retire the env)

- **Registry** `packages/state-postgres/src/catalog-retrieval-enablement.ts` (mirror `autopromote-optin.ts`):
  - `readPlatformEnabled(store): Promise<boolean>` — reads `__system__` partition, key
    `catalog_retrieval`/`platform`, default `false`.
  - `readTenantOptIn(store, tenantId): Promise<boolean>` — reads `{tenantId}` partition,
    `catalog_retrieval`/`optin`, default `false`.
  - `catalogRetrievalEnabledFor(store, tenantId): Promise<boolean> = master && tenantOptIn`.
  - Setters `setPlatformEnabled(store, on, reason)` / `setTenantOptIn(store, tenantId, on, reason)` — each in
    a `store.tx` with an atomic audit row (mirror `armKill`).
- **CLI** `packages/widget-backend/src/jobs/catalog-enable.ts` + `pnpm catalog:enable`
  (mirror `kill-switch.ts`): `--scope platform|tenant:<id> --on|--off [--reason "..."]`; refuses an unknown
  scope; prints the resulting state. Runs against the same `DATABASE_URL` serving uses.
- **Serving** (`server.ts`): the retriever is constructed **unconditionally** (dark until a tenant is
  enabled — it is stateless infra). The per-turn request path resolves
  `catalogRetrievalEnabledFor(store, tenantId)` and threads that PER-TENANT boolean into `brainFor(tenantId)`
  (replacing the global `CATALOG_RETRIEVAL` boolean at `:686`). **Delete the `process.env.CATALOG_RETRIEVAL`
  read** (`:586`) and its threading; `CATALOG_RETRIEVAL_K` stays. Cache note: `brainFor` currently caches per
  `(tenantId, policy)` — the enablement boolean must be applied at request time, not baked into a cached
  brain, OR the cache key must include it (the plan picks; simplest: pass enablement as a per-call arg /
  resolve in `decide`'s caller, not the cached construction).
- **Dark / flag-off:** master + all opt-ins default OFF ⇒ `catalogRetrievalEnabledFor` is false for everyone
  ⇒ serving uses `getContext` ⇒ the S2 flag-off goldens stay byte-identical.
- **Tests:** gate truth table (master off/tenant on, master on/tenant off, both on/off); CLI writes the
  registry + audit row; serving threads the per-tenant boolean (a tenant opted-in gets retrieval, another on
  the same process does not); flag-off goldens byte-identical; no `process.env.CATALOG_RETRIEVAL` read remains
  (grep-guard).

## §C — Retrieval-scoped kill (degrade, not halt)

- **Read** on `/chat`: add `const retrievalKill = await matchedKill(store, {tenantId,
  agentType: CATALOG_RETRIEVAL_AGENT_TYPE})` (`CATALOG_RETRIEVAL_AGENT_TYPE = "catalog-retrieval"`, already
  the metering agentType at `server.ts:627`), alongside the existing shopper-kill read; precedence
  global>tenant>agent is already handled by `matchedKill`.
- **Thread** a new signal `catalogRetrievalKilled` into the brain (distinct from `signals.kill`). In the
  brain's retrieval branch (`brain.ts:1027`), treat `catalogRetrievalEnabled && !catalogRetrievalKilled` —
  when killed, fall to the `else` (`getContext`, full-catalog degrade). Add a `retrieval:killed` decision flag
  for the audit log.
- **Arm** via the existing `pnpm kill:arm --scope agent:catalog-retrieval` (parses today) — NET-NEW is only
  the read + degrade. The global/tenant/shopper turn-halt kills are unchanged.
- **Tests:** retrieval killed → brain uses getContext (not the retrieval path, not a turn halt), `retrieval:killed`
  flagged; a normal turn unaffected; the shopper turn-halt kill still halts.

## §D — eval/shadow at pgvector-scale + recorded evidence

- **Injectable store/vector:** extend `buildIndexedRetriever` (`retrieval-eval.ts`) to accept an injected
  `store`/`vector` (default stays in-memory for the existing demo runs), so `eval:retrieval` /
  `shadow:retrieval` can run against the pgvector adapter (`createVectorStore` under `VECTOR_ANN=true`) on a
  scale-representative corpus (a generator producing ≥5000 synthetic products, or a real tenant catalog).
- **Evidence artifact:** a writer emitting `reports/retrieval-promotion-evidence-<tenant>-<stamp>.json`
  (schema: `{tenantId, model, dimension, corpusSize, recallAtK, noWrongProduct, shadow:{fabricated,stale,
  missingProduct}, vectorAnn:true, at}`) so the §5 evidence is a structured, retained record, not just
  stdout+exit-code.
- **Runbook** (`docs/DEPLOY.md`): the operator runs `eval:retrieval` + `shadow:retrieval` with real Vertex +
  real pgvector at the tenant's scale, producing the artifact, before enabling that tenant.
- **CI/test path:** a testcontainer test proves the harness wires to pgvector + emits the artifact shape on
  the mock/fake-embed path (no real Vertex). The real-Vertex-at-scale run is the operator §5 step, NOT CI.
- **Tests:** `buildIndexedRetriever` uses the injected pgvector store (testcontainer); the artifact writer
  emits the schema; exit-code semantics preserved.

## §E — #295 amendment (S4 carries it; #295 superseded)

- Update `docs/HITL-POLICY.md` §5 CATALOG_RETRIEVAL block + `docs/adr/0020-durable-grounding-at-scale.md`:
  the two compensating controls now EXIST — cite `catalog-retrieval-enablement.ts` + `pnpm catalog:enable`
  (per-tenant staged) and the `agent:catalog-retrieval` kill read (retrieval-scoped Kill Switch). Fix the
  stale "1000-product ceiling" caveat (50000 index / 1000 serving-fetch / >5000 needs VECTOR_ANN). State the
  per-tenant promotion bar: recorded real-Vertex `eval:retrieval` pass + `shadow:retrieval` pass (the §D
  artifact) + named-owner sign-off (merge + Audit Log at each per-tenant flip).
- **Governance:** additive amendment where possible; if any policy text is reclassified/removed, the
  merge-gate requires `POLICY_REVIEWED`. Human-merged by jason; recommend closing #295 as superseded.
- **Tests:** none (docs); merge-gate governance-no-weakening guard applies.

## §F — S3-surfaced §5 preconditions (folded in)

- **pgvector-safe `runCatalogClear`:** replace its `vector.query({text:""})` count queries
  (`catalog-index.ts:1040,1042`, throw on pgvector) with the ledger-based approach (ledger size for
  before/after; `deleteNamespace` + `deleteLedgerInTx` for the wipe) — mirroring what S3·T2 did for the index
  path. Test on the pgvector testcontainer (clear no longer throws).
- **Statutory erasure wiring:** call `runCatalogClear` (corpus namespace + ledger) from `handleShopRedact`
  AND the `app/uninstalled` handler (`routes/shopify-webhooks.ts`); once actually erased, remove the catalog
  corpus + ledger from the `SHOP_REDACT_RESIDUAL` disclosure (S3 added it as a disclosed gap). This is a
  statutory/ADR-0015 path — security-review it. Test: a redact/uninstall erases the tenant's corpus + all
  ledger chunks.
- **Concurrency guard (fetch-timestamp):** the full reconcile records `fetchStartedAt`; ledger entries carry a
  per-entry `writtenAt`; the full reconcile's stale-set EXCLUDES any ledger entry with `writtenAt >
  fetchStartedAt` (a concurrent webhook wrote it after the snapshot). Prevents the hourly job deleting a
  just-created product. **Ledger-shape migration (S3→S4):** the S3 ledger entry is `id → contentHash`; extend
  it to `id → { hash, writtenAt }` (or a parallel `writtenAt` map in the ledger record). Back-compat: an entry
  read without a `writtenAt` (written pre-S4) is treated as `writtenAt = 0`, so it stays normally reconcilable
  (never spuriously protected); a `--reindex` rewrites all entries in the new shape. Keep the chunking +
  atomic-with-manifest properties S3 established. Test: simulate the interleaving (webhook writes entry X after
  the job's fetch snapshot; the job's reconcile does NOT delete X) + the pre-S4-entry back-compat.

## §G — Testing & governance

ATDD; `env -u GOOGLE_CLOUD_PROJECT`; mock + pgvector-testcontainer; NO real Vertex in CI (fake embed;
real-Vertex-at-scale is the operator runbook step). Ships dark — no CATALOG_RETRIEVAL/VECTOR_ANN/
MEMORY_ADR_ACCEPTED/PRODUCT_FACTS_HYDRATION flip; enablement + kill are CLI/KV, never code. No VectorPort
interface change. Portability: no vendor SQL in feature code (the concurrency guard is app-level, not a pg
advisory lock). Human-merged by jason. The seven merge-gate step names unchanged. Security review REQUIRED
(§C kill, §F statutory erasure, §B per-tenant enablement all touch governance/customer-data/autonomy).

## §H — Outcome

When S4 merges + the operator runs the §5 promotion (recorded eval+shadow evidence + per-tenant `catalog:enable`
+ named sign-off + Audit Log), `CATALOG_RETRIEVAL` can serve one merchant at a time with an instant
retrieval-scoped rollback — the compensating controls #295 assumed. #295 is superseded. A2 is complete.
