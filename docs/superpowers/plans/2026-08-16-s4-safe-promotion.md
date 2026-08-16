# S4 — Safe Promotion (A2 / ADR-0020) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the two compensating controls (per-tenant staged enablement + a retrieval-scoped kill) plus scale-representative eval/shadow evidence and the S3-surfaced statutory-erasure/concurrency fixes, so `CATALOG_RETRIEVAL` can be promoted to real shoppers one merchant at a time — shipping dark, no flag flipped.

**Architecture:** Retire the process-global `process.env.CATALOG_RETRIEVAL` boot flag. Retrieval becomes a per-turn decision resolved from two `RuntimeStatePort` KV gates (a platform master under `__system__` + a per-tenant opt-in), both default OFF, set via a new audited `pnpm catalog:enable` CLI (mirroring `kill:arm`). The per-tenant boolean and an `agent:catalog-retrieval` kill read ride the server-derived `Signals` object into the brain, which degrades to the full-catalog `getContext` path when disabled or killed. eval/shadow gain a scale corpus generator + a structured evidence artifact; `runCatalogClear` and the hourly reconcile are made pgvector-safe and concurrency-safe; `shop/redact` + `app/uninstalled` erase the catalog corpus.

**Tech Stack:** TypeScript (strict), Node + Fastify (widget-backend), `@palup/state-postgres` (Cloud SQL adapters + pgvector), `@palup/platform-ports` (`RuntimeStatePort`/`VectorPort`), `@palup/widget-brain` (the shopper brain), Vitest (unit + testcontainer), testcontainers (`pgvector/pgvector:pg16`).

**Spec:** `docs/superpowers/specs/2026-08-16-s4-safe-promotion-design.md` (the authority — read it fully before starting; this plan argues from it).

## Global Constraints

Every task's requirements implicitly include this section. Copied verbatim from the spec's §G + the task brief:

- **Test-first (ATDD).** Author the failing unit/testcontainer test from the acceptance criterion BEFORE the implementation, and watch it fail (red) before writing code.
- **`env -u GOOGLE_CLOUD_PROJECT` on every test run.** Setting `GOOGLE_CLOUD_PROJECT` routes backend tests to real Vertex (5000ms timeouts that look like regressions). Never set it for `pnpm test` / `merge-gate.sh`.
- **Mock + pgvector-testcontainer only. NO real Vertex in CI.** Use a fake/bag-of-words embed model. The real-Vertex-at-scale eval/shadow run is the operator's HITL-POLICY §5 runbook step, NOT CI.
- **Ships dark.** Enablement + kill are set via CLI/KV, NEVER flipped in code. Do NOT flip `CATALOG_RETRIEVAL` (now retired), `VECTOR_ANN`, `MEMORY_ADR_ACCEPTED`, or `PRODUCT_FACTS_HYDRATION`. Enabling a tenant is the §5 human step, never a build agent's.
- **No `VectorPort` interface change.** `VectorPort` exposes no listIds/count/enumerate — do not add one (non-portable, MEMORY-GO-LIVE-CHECKLIST).
- **Portability (ADR-0001).** No vendor SQL in feature code. The concurrency guard is app-level (a fetch-timestamp compare), NOT a pg advisory lock.
- **Secrets never printed.** No secret in code, prompts, or logs.
- **The seven merge-gate step names are unchanged.** Add tests to existing suites/scripts; do not rename steps.
- **Human-merged by jason.hsu.** S4 is governance-touching (§B per-tenant enablement, §C kill, §F statutory erasure). Security review is REQUIRED before merge.

---

## File Structure

**Created:**
- `packages/state-postgres/src/catalog-retrieval-enablement.ts` — the two-gate registry (Task 1).
- `packages/state-postgres/test/catalog-retrieval-enablement.test.ts` — registry unit tests (Task 1).
- `packages/widget-backend/src/jobs/catalog-enable.ts` — the `pnpm catalog:enable` CLI (Task 2).
- `packages/widget-backend/test/catalog-enable-job.test.ts` — CLI unit tests (Task 2).
- `packages/widget-backend/src/retrieval-promotion-evidence.ts` — the evidence-artifact writer + schema (Task 5).
- `packages/widget-backend/test/retrieval-promotion-evidence.test.ts` — evidence + scale-corpus + pgvector wiring test (Task 5).

**Modified:**
- `packages/state-postgres/src/index.ts` — export the new registry (Task 1).
- `packages/widget-brain/src/types.ts` — two new `Signals` fields (Tasks 3, 4).
- `packages/widget-brain/src/brain.ts` — per-turn retrieval gate + kill degrade + `retrieval:killed` flag (Tasks 3, 4).
- `packages/widget-backend/src/signals.ts` — two new `ServingSignalContext` pass-throughs (Tasks 3, 4).
- `packages/widget-backend/src/server.ts` — retire the env, build the retriever unconditionally, resolve per-tenant enablement + retrieval-kill per turn (Tasks 3, 4).
- `packages/widget-backend/src/retrieval-eval.ts` — scale-corpus generator (Task 5).
- `packages/widget-backend/src/jobs/catalog-index.ts` — pgvector-safe `runCatalogClear` (Task 6) + ledger-writtenAt + concurrency guard in `indexOneTenant`/`writeManifestAndAudit` (Task 7).
- `packages/widget-backend/src/jobs/catalog-ledger.ts` — optional per-entry `writtenAt` + a timestamps reader (Task 7).
- `packages/widget-backend/src/routes/shopify-webhooks.ts` — call `runCatalogClear` from `shop/redact` + `app/uninstalled`; update `SHOP_REDACT_RESIDUAL` (Task 8).
- `package.json` — `catalog:enable*` scripts (Task 2); add the new pgvector test to `test:pgvector` (Tasks 5, 6, 7).
- `docs/HITL-POLICY.md`, `docs/adr/0020-durable-grounding-at-scale.md` — the #295 amendment (Task 9).

## Pre-flight — shared-file conflicts across tasks

Execute tasks **in the numbered order**; several tasks edit the same file and later edits assume earlier ones. Seams:

- **`packages/widget-brain/src/types.ts`** — Task 3 adds `Signals.catalogRetrievalEnabled?`; Task 4 adds `Signals.catalogRetrievalKilled?`. Both append optional fields to the same interface. Do 3 before 4.
- **`packages/widget-brain/src/brain.ts`** — Task 3 folds the enablement gate into the `retrieval` object and computes `catalogRetrievalOn`; Task 4 edits that same `catalogRetrievalOn` expression to AND-in `!signals.catalogRetrievalKilled` and pushes `retrieval:killed`. Same lines. Do 3 before 4.
- **`packages/widget-backend/src/signals.ts`** — Task 3 adds the `catalogRetrievalEnabled` pass-through; Task 4 adds `catalogRetrievalKilled`. Same `ServingSignalContext` + same return object. Do 3 before 4.
- **`packages/widget-backend/src/server.ts`** — Task 3 retires the env read, builds the retriever unconditionally, and threads per-tenant enablement into `deriveServingSignals`; Task 4 adds the `matchedKill(agent:catalog-retrieval)` read alongside it in the `/chat` handler. Same handler region (~`:586`, `:624-630`, `:680-712`, `:2112`/`:2274`). Do 3 before 4.
- **`packages/widget-backend/src/jobs/catalog-index.ts`** — Task 6 rewrites `runCatalogClear` (`~:1032-1068`); Task 7 edits `indexOneTenant` (`~:479`, `~:561`), the ledger write in `writeManifestAndAudit` (`~:766-800`), and `reconcileProducts` (`~:951-971`). **Different functions, same file** — a reviewer can accept one and reject the other, but land 6 before 7 to avoid a rebase, and land 6 before 8 (Task 8 wires the now-safe `runCatalogClear` into webhooks; wiring a throwing clear would break redact).
- **`packages/widget-backend/src/jobs/catalog-ledger.ts`** — only Task 7 edits it.
- **`package.json`** — Task 2 adds `catalog:enable*` scripts; Tasks 5/6/7 append test files to the `test:pgvector` script string. Non-overlapping keys, but re-read the file before each edit.
- **`packages/state-postgres/src/index.ts`** — only Task 1 edits it.

Dependency order: **1 → 2, 1 → 3 → 4** (enablement registry underlies both the CLI and serving; the kill builds on the enablement signal path). **6 → 7 → 8.** Task 5 depends on nothing but Task 1's registry is unrelated to it. **Task 9 (docs) last** — it cites every prior task's landed symbols.

---

## Task 1: catalog-retrieval-enablement registry (state-postgres)

Mirror `packages/state-postgres/src/autopromote-optin.ts`: a platform master under the `__system__` tenant AND a per-tenant opt-in, both default OFF, retrieval enabled iff BOTH on. Setters write in a `store.tx` with an atomic audit row (mirror `armKill`). Simpler than autopromote — **no step-up** (parity with `kill:arm`, whose authorization is the `DATABASE_URL` credential, per `kill-switch.ts`'s header).

**Files:**
- Create: `packages/state-postgres/src/catalog-retrieval-enablement.ts`
- Create: `packages/state-postgres/test/catalog-retrieval-enablement.test.ts`
- Modify: `packages/state-postgres/src/index.ts` (add the export block)

**Interfaces:**
- Consumes: `RuntimeStatePort` from `@palup/platform-ports` (`get<T>(ctx, collection, key)`, `list<T>`, `tx(ctx, fn)`; inside `tx`: `t.put`, `t.audit`), `InMemoryRuntimeStore` (tests). Confirmed signatures in `packages/platform-ports/src/runtime-state-port.ts:64-125`.
- Produces (later tasks rely on these EXACT names/types):
  - `export const CATALOG_RETRIEVAL_PLATFORM_TENANT = "__system__"`
  - `readPlatformEnabled(store: RuntimeStatePort): Promise<boolean>`
  - `readTenantOptIn(store: RuntimeStatePort, tenantId: string): Promise<boolean>`
  - `catalogRetrievalEnabledFor(store: RuntimeStatePort, tenantId: string): Promise<boolean>`
  - `setPlatformEnabled(store: RuntimeStatePort, enabled: boolean, opts?: { actor?: string; reason?: string; now?: number }): Promise<void>`
  - `setTenantOptIn(store: RuntimeStatePort, tenantId: string, enabled: boolean, opts?: { actor?: string; reason?: string; now?: number }): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `packages/state-postgres/test/catalog-retrieval-enablement.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import {
  readPlatformEnabled,
  readTenantOptIn,
  catalogRetrievalEnabledFor,
  setPlatformEnabled,
  setTenantOptIn,
  CATALOG_RETRIEVAL_PLATFORM_TENANT,
} from "../src/catalog-retrieval-enablement.js";

describe("catalog-retrieval-enablement — gate truth table (both default OFF)", () => {
  it("is false for everyone when nothing is set", async () => {
    const store = new InMemoryRuntimeStore();
    expect(await readPlatformEnabled(store)).toBe(false);
    expect(await readTenantOptIn(store, "t1")).toBe(false);
    expect(await catalogRetrievalEnabledFor(store, "t1")).toBe(false);
  });

  it("requires BOTH master AND tenant opt-in", async () => {
    const store = new InMemoryRuntimeStore();
    await setTenantOptIn(store, "t1", true, { actor: "jason", reason: "canary" });
    expect(await catalogRetrievalEnabledFor(store, "t1")).toBe(false); // master still off

    await setPlatformEnabled(store, true, { actor: "jason", reason: "open the master" });
    expect(await catalogRetrievalEnabledFor(store, "t1")).toBe(true); // both on

    expect(await catalogRetrievalEnabledFor(store, "t2")).toBe(false); // t2 never opted in
    await setPlatformEnabled(store, false, { actor: "jason", reason: "close the master" });
    expect(await catalogRetrievalEnabledFor(store, "t1")).toBe(false); // master wins
  });

  it("setters write an atomic audit row naming the actor and the reversal path", async () => {
    const store = new InMemoryRuntimeStore();
    await setTenantOptIn(store, "t1", true, { actor: "jason", reason: "canary #295" });
    const audit = await store.readAudit({ tenantId: "t1" });
    expect(audit.at(-1)).toMatchObject({
      actor: "jason",
      action: "catalog_retrieval.tenant_optin.enable",
    });
    expect(audit.at(-1)!.reversalPath).toContain("catalog:enable");

    await setPlatformEnabled(store, true, { reason: "master" });
    const sysAudit = await store.readAudit({ tenantId: CATALOG_RETRIEVAL_PLATFORM_TENANT });
    expect(sysAudit.at(-1)).toMatchObject({ action: "catalog_retrieval.platform.enable" });
    expect(sysAudit.at(-1)!.actor).toBe("operator"); // default actor when none supplied
  });

  it("refuses the reserved __system__ tenant as a merchant opt-in", async () => {
    const store = new InMemoryRuntimeStore();
    await expect(setTenantOptIn(store, CATALOG_RETRIEVAL_PLATFORM_TENANT, true)).rejects.toThrow(/real merchant/);
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm --filter @palup/state-postgres exec vitest run test/catalog-retrieval-enablement.test.ts`
Expected: FAIL — `Cannot find module '../src/catalog-retrieval-enablement.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/state-postgres/src/catalog-retrieval-enablement.ts`:

```ts
import type { RuntimeStatePort, RuntimeStateCtx } from "@palup/platform-ports";

// S4 §B (ADR-0020) — the two gates that decide, PER TENANT, whether CATALOG_RETRIEVAL serves this
// merchant. BOTH default OFF so a fresh deployment is dark, mirroring autopromote-optin.ts:
//   • platform master  `catalog_retrieval`/`platform`  under the reserved __system__ tenant;
//   • per-tenant opt-in `catalog_retrieval`/`optin`     under the merchant's own partition.
// Retrieval is enabled for a tenant IFF both are on (the master wins when off). Set via the audited
// `pnpm catalog:enable` CLI, written + AUDITED atomically inside one store.tx (armKill's shape). The
// value is server-sourced — read only from this store, never from a client/agent field. This replaces
// the retired process-global `process.env.CATALOG_RETRIEVAL` boot flag (S4 §B; server.ts).

const COLLECTION = "catalog_retrieval";
const OPTIN_KEY = "optin";
const PLATFORM_KEY = "platform";

/** Reserved platform partition for the global master (not a real merchant). */
export const CATALOG_RETRIEVAL_PLATFORM_TENANT = "__system__";

export async function readPlatformEnabled(store: RuntimeStatePort): Promise<boolean> {
  return (
    (await store.get<{ enabled: boolean }>({ tenantId: CATALOG_RETRIEVAL_PLATFORM_TENANT }, COLLECTION, PLATFORM_KEY))
      ?.enabled === true
  );
}

export async function readTenantOptIn(store: RuntimeStatePort, tenantId: string): Promise<boolean> {
  return (await store.get<{ enabled: boolean }>({ tenantId }, COLLECTION, OPTIN_KEY))?.enabled === true;
}

/** The single serving read: is retrieval enabled for this tenant right now? Default OFF for everyone. */
export async function catalogRetrievalEnabledFor(store: RuntimeStatePort, tenantId: string): Promise<boolean> {
  const [master, optin] = await Promise.all([readPlatformEnabled(store), readTenantOptIn(store, tenantId)]);
  return master && optin;
}

export interface SetEnablementOpts {
  /** Recorded audit actor (the human names themselves via the CLI --reason; default "operator"). */
  actor?: string;
  reason?: string;
  now?: number;
}

async function setFlag(
  store: RuntimeStatePort,
  ctx: RuntimeStateCtx,
  key: string,
  action: string,
  enabled: boolean,
  opts: SetEnablementOpts,
): Promise<void> {
  const at = new Date(opts.now ?? Date.now()).toISOString();
  const actor = opts.actor || "operator";
  await store.tx(ctx, async (t) => {
    await t.put(COLLECTION, key, { enabled });
    await t.audit(
      {
        actor,
        action: enabled ? `${action}.enable` : `${action}.disable`,
        input: { tenantId: ctx.tenantId, enabled, reason: opts.reason },
        decision: `catalog_retrieval ${key} set to ${enabled}`,
        reversalPath:
          key === PLATFORM_KEY
            ? `pnpm catalog:enable --scope platform --${enabled ? "off" : "on"}`
            : `pnpm catalog:enable --scope tenant:${ctx.tenantId} --${enabled ? "off" : "on"}`,
      },
      at,
    );
  });
}

/** SET the platform master (audited). */
export async function setPlatformEnabled(store: RuntimeStatePort, enabled: boolean, opts: SetEnablementOpts = {}): Promise<void> {
  await setFlag(store, { tenantId: CATALOG_RETRIEVAL_PLATFORM_TENANT }, PLATFORM_KEY, "catalog_retrieval.platform", enabled, opts);
}

/** SET a merchant's opt-in (audited). Refuses the reserved system tenant. */
export async function setTenantOptIn(store: RuntimeStatePort, tenantId: string, enabled: boolean, opts: SetEnablementOpts = {}): Promise<void> {
  if (!tenantId || tenantId === CATALOG_RETRIEVAL_PLATFORM_TENANT) {
    throw new Error("setTenantOptIn requires a real merchant tenantId (not the reserved __system__ partition)");
  }
  await setFlag(store, { tenantId }, OPTIN_KEY, "catalog_retrieval.tenant_optin", enabled, opts);
}
```

- [ ] **Step 4: Export from the package index**

In `packages/state-postgres/src/index.ts`, after the `autopromote-optin.js` export block (`~:71-84`), add:

```ts
export {
  readPlatformEnabled as readCatalogRetrievalPlatformEnabled,
  readTenantOptIn as readCatalogRetrievalTenantOptIn,
  catalogRetrievalEnabledFor,
  setPlatformEnabled as setCatalogRetrievalPlatformEnabled,
  setTenantOptIn as setCatalogRetrievalTenantOptIn,
  CATALOG_RETRIEVAL_PLATFORM_TENANT,
  type SetEnablementOpts,
} from "./catalog-retrieval-enablement.js";
```

(The `read/set` names are aliased on export because `readTenantOptIn`/`readPlatformEnabled`/`setPlatformEnabled` already exist from `autopromote-optin.js` — do NOT collide. `catalogRetrievalEnabledFor` and `CATALOG_RETRIEVAL_PLATFORM_TENANT` are unique and exported as-is.)

- [ ] **Step 5: Run the tests — verify they pass**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm --filter @palup/state-postgres exec vitest run test/catalog-retrieval-enablement.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck the package**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm --filter @palup/state-postgres exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/state-postgres/src/catalog-retrieval-enablement.ts packages/state-postgres/test/catalog-retrieval-enablement.test.ts packages/state-postgres/src/index.ts
git commit -m "feat(catalog-retrieval): per-tenant + platform-master enablement registry (S4 §B; ships dark)"
```

---

## Task 2: `pnpm catalog:enable` CLI (widget-backend)

Mirror `packages/widget-backend/src/jobs/kill-switch.ts`: parse `--scope platform|tenant:<id> --on|--off [--reason "..."]`, refuse an unknown/implicit scope, require `DATABASE_URL` (the shared store the server reads), read the resulting state back and print it. No secret is printed.

**Files:**
- Create: `packages/widget-backend/src/jobs/catalog-enable.ts`
- Create: `packages/widget-backend/test/catalog-enable-job.test.ts`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes (Task 1): `setCatalogRetrievalPlatformEnabled`, `setCatalogRetrievalTenantOptIn`, `readCatalogRetrievalPlatformEnabled`, `readCatalogRetrievalTenantOptIn`, `catalogRetrievalEnabledFor`, `CATALOG_RETRIEVAL_PLATFORM_TENANT` from `@palup/state-postgres`; `createRuntimeStore` from `@palup/state-postgres`; `RuntimeStatePort` from `@palup/platform-ports`.
- Produces:
  - `export type CatalogEnableScope = "platform" | \`tenant:${string}\``
  - `export interface CatalogEnableCommand { scope: CatalogEnableScope; on: boolean; reason?: string }`
  - `export class CatalogEnableArgsError extends Error`
  - `parseCatalogEnableArgv(argv: string[]): CatalogEnableCommand`
  - `export interface CatalogEnableReport { scope: string; on: boolean; platformEnabled: boolean; tenantOptIn?: boolean; effective?: boolean }`
  - `runCatalogEnable(deps: { store: RuntimeStatePort }, cmd: CatalogEnableCommand): Promise<CatalogEnableReport>`

- [ ] **Step 1: Write the failing test**

Create `packages/widget-backend/test/catalog-enable-job.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { catalogRetrievalEnabledFor } from "@palup/state-postgres";
import {
  parseCatalogEnableArgv,
  runCatalogEnable,
  CatalogEnableArgsError,
} from "../src/jobs/catalog-enable.js";

describe("catalog-enable — argv parsing", () => {
  it("parses a tenant opt-in on", () => {
    expect(parseCatalogEnableArgv(["--scope", "tenant:acme", "--on", "--reason", "canary"])).toEqual({
      scope: "tenant:acme",
      on: true,
      reason: "canary",
    });
  });
  it("parses the platform master off", () => {
    expect(parseCatalogEnableArgv(["--scope", "platform", "--off"])).toEqual({ scope: "platform", on: false });
  });
  it("refuses a missing scope (never an implicit one)", () => {
    expect(() => parseCatalogEnableArgv(["--on"])).toThrow(CatalogEnableArgsError);
  });
  it("refuses an unparseable scope", () => {
    expect(() => parseCatalogEnableArgv(["--scope", "everyone", "--on"])).toThrow(/global|tenant:/);
  });
  it("refuses when neither --on nor --off is given, and when both are", () => {
    expect(() => parseCatalogEnableArgv(["--scope", "platform"])).toThrow(CatalogEnableArgsError);
    expect(() => parseCatalogEnableArgv(["--scope", "platform", "--on", "--off"])).toThrow(CatalogEnableArgsError);
  });
});

describe("catalog-enable — runs against the store, audits, reads back", () => {
  it("sets a tenant opt-in and reports the effective (both-gate) state", async () => {
    const store = new InMemoryRuntimeStore();
    const r1 = await runCatalogEnable({ store }, { scope: "tenant:acme", on: true, reason: "canary" });
    expect(r1.tenantOptIn).toBe(true);
    expect(r1.effective).toBe(false); // master still off
    expect(await catalogRetrievalEnabledFor(store, "acme")).toBe(false);

    const r2 = await runCatalogEnable({ store }, { scope: "platform", on: true });
    expect(r2.platformEnabled).toBe(true);
    expect(await catalogRetrievalEnabledFor(store, "acme")).toBe(true);

    const audit = await store.readAudit({ tenantId: "acme" });
    expect(audit.at(-1)!.action).toBe("catalog_retrieval.tenant_optin.enable");
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm --filter @palup/widget-backend exec vitest run test/catalog-enable-job.test.ts`
Expected: FAIL — `Cannot find module '../src/jobs/catalog-enable.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/widget-backend/src/jobs/catalog-enable.ts`:

```ts
import type { RuntimeStatePort } from "@palup/platform-ports";
import {
  createRuntimeStore,
  setCatalogRetrievalPlatformEnabled,
  setCatalogRetrievalTenantOptIn,
  readCatalogRetrievalPlatformEnabled,
  readCatalogRetrievalTenantOptIn,
  catalogRetrievalEnabledFor,
} from "@palup/state-postgres";

// S4 §B — the OPERATOR entry point for staged CATALOG_RETRIEVAL enablement. Mirrors kill-switch.ts:
// no implicit scope, requires the SAME DATABASE_URL the deployed backend reads (else the setting lands in
// a per-process in-memory store the server never sees), writes+audits atomically (via the registry), and
// reads the resulting state BACK so "enabled" is a confirmed observation, not an assumption. Turning a
// tenant on is a HITL-POLICY §5 named-owner promotion; --reason is where the human names themselves.

export type CatalogEnableScope = "platform" | `tenant:${string}`;

export interface CatalogEnableCommand {
  scope: CatalogEnableScope;
  on: boolean;
  reason?: string;
}

export class CatalogEnableArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogEnableArgsError";
  }
}

export const CATALOG_ENABLE_USAGE = [
  "usage:",
  '  pnpm catalog:enable --scope <platform|tenant:ID> --on|--off [--reason "why (your name)"]',
  "",
  "DATABASE_URL must point at the SAME run-time state store the deployed backend uses.",
  "There is no default scope, by design. Turning a tenant on is a HITL-POLICY §5 human promotion.",
].join("\n");

function parseScope(raw: string): CatalogEnableScope {
  if (raw === "platform") return "platform";
  const m = /^tenant:(.+)$/.exec(raw);
  if (!m || /\s/.test(m[1]!) || m[1]!.length > 128) {
    throw new CatalogEnableArgsError(`unparseable --scope "${raw}" — expected platform or tenant:<id>`);
  }
  return `tenant:${m[1]}` as CatalogEnableScope;
}

export function parseCatalogEnableArgv(argv: string[]): CatalogEnableCommand {
  let rawScope: string | undefined;
  let on: boolean | undefined;
  let reason: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--on") {
      if (on === false) throw new CatalogEnableArgsError("give exactly one of --on / --off");
      on = true;
    } else if (arg === "--off") {
      if (on === true) throw new CatalogEnableArgsError("give exactly one of --on / --off");
      on = false;
    } else if (arg === "--scope" || arg === "--reason") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new CatalogEnableArgsError(`${arg} requires a value`);
      if (arg === "--scope") rawScope = next;
      else reason = next;
      i++;
    } else {
      throw new CatalogEnableArgsError(`unknown argument "${arg}"`);
    }
  }
  if (rawScope === undefined) throw new CatalogEnableArgsError("--scope <platform|tenant:ID> is required — there is no default scope");
  if (on === undefined) throw new CatalogEnableArgsError("give exactly one of --on / --off");
  return { scope: parseScope(rawScope), on, ...(reason === undefined ? {} : { reason }) };
}

export interface CatalogEnableReport {
  scope: string;
  on: boolean;
  platformEnabled: boolean;
  tenantOptIn?: boolean;
  effective?: boolean;
}

export async function runCatalogEnable(deps: { store: RuntimeStatePort }, cmd: CatalogEnableCommand): Promise<CatalogEnableReport> {
  const opts = { actor: "operator", ...(cmd.reason === undefined ? {} : { reason: cmd.reason }) };
  if (cmd.scope === "platform") {
    await setCatalogRetrievalPlatformEnabled(deps.store, cmd.on, opts);
    return { scope: "platform", on: cmd.on, platformEnabled: await readCatalogRetrievalPlatformEnabled(deps.store) };
  }
  const tenantId = cmd.scope.slice("tenant:".length);
  await setCatalogRetrievalTenantOptIn(deps.store, tenantId, cmd.on, opts);
  const [platformEnabled, tenantOptIn, effective] = await Promise.all([
    readCatalogRetrievalPlatformEnabled(deps.store),
    readCatalogRetrievalTenantOptIn(deps.store, tenantId),
    catalogRetrievalEnabledFor(deps.store, tenantId),
  ]);
  return { scope: cmd.scope, on: cmd.on, platformEnabled, tenantOptIn, effective };
}

async function resolveStore(): Promise<{ store: RuntimeStatePort; kind: string }> {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is unset — refusing to run. Without it this process gets its OWN in-memory store, so the " +
        "enablement would never reach the deployed backend. Point DATABASE_URL at the same Cloud SQL instance.",
    );
  }
  return createRuntimeStore();
}

async function main(): Promise<void> {
  let cmd: CatalogEnableCommand;
  try {
    cmd = parseCatalogEnableArgv(process.argv.slice(2));
  } catch (e) {
    console.error(`[catalog-enable] ${(e as Error).message}\n\n${CATALOG_ENABLE_USAGE}`);
    process.exit(2);
    return;
  }
  try {
    const { store, kind } = await resolveStore();
    const report = await runCatalogEnable({ store }, cmd);
    console.log(`[catalog-enable] store=${kind} scope=${report.scope} set=${report.on ? "ON" : "OFF"}`);
    console.log(`[catalog-enable]   platformEnabled=${report.platformEnabled}` +
      (report.tenantOptIn !== undefined ? ` tenantOptIn=${report.tenantOptIn} effective=${report.effective}` : ""));
    if (report.scope !== "platform" && report.effective) {
      console.log("[catalog-enable] retrieval is now EFFECTIVE for this tenant (HITL-POLICY §5 promotion — ensure recorded eval+shadow evidence + named sign-off).");
    }
    process.exit(0);
  } catch (e) {
    console.error(`[catalog-enable] FAILED: ${(e as Error).message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
```

- [ ] **Step 4: Register the scripts**

In `package.json` `scripts`, next to the `catalog:index` / `catalog:clear` entries (`~:39-40`), add:

```json
    "catalog:enable": "tsx packages/widget-backend/src/jobs/catalog-enable.ts",
```

(No subcommand suffix — unlike `kill:arm`, `catalog:enable` takes its verb from `--on`/`--off`, so a single script is correct. Operators run `pnpm catalog:enable --scope tenant:acme --on --reason "..."`.)

- [ ] **Step 5: Run the tests — verify they pass**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm --filter @palup/widget-backend exec vitest run test/catalog-enable-job.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/widget-backend/src/jobs/catalog-enable.ts packages/widget-backend/test/catalog-enable-job.test.ts package.json
git commit -m "feat(catalog-retrieval): pnpm catalog:enable CLI, audited, no implicit scope (S4 §B)"
```

---

## Task 3: Serving rewire — retire the env, per-tenant enablement per turn

Retire `process.env.CATALOG_RETRIEVAL`. Build the retriever unconditionally (stateless infra, dark until a tenant is enabled). Resolve `catalogRetrievalEnabledFor(store, tenantId)` per turn and thread that per-tenant boolean into the brain via `Signals` (server-derived, like `kill`/`atCap`) — NOT baked into the per-`(tenantId, policy)`-cached brain. The brain folds the gate into its per-turn `retrieval` object, so the cache is untouched and flag-off goldens stay byte-identical.

**Files:**
- Modify: `packages/widget-brain/src/types.ts` (`Signals`)
- Modify: `packages/widget-brain/src/brain.ts` (retrieval gate)
- Modify: `packages/widget-backend/src/signals.ts` (`ServingSignalContext` + `deriveServingSignals`)
- Modify: `packages/widget-backend/src/server.ts` (`~:586`, `~:624-630`, `~:661`, `~:680-712`, `~:2274`)
- Create/extend tests: `packages/widget-brain/test/brain-catalog-per-turn.test.ts`, `packages/widget-backend/test/serving-catalog-per-tenant.test.ts`

**Interfaces:**
- Consumes (Task 1): `catalogRetrievalEnabledFor` from `@palup/state-postgres`.
- Consumes (existing, confirmed): `createCatalogRetriever`, `CATALOG_RETRIEVAL_AGENT_TYPE` from `./catalog-retriever.js` (`server.ts:14`, def `catalog-retriever.ts:59`); `DEFAULT_CATALOG_RETRIEVAL_K = 12` (`brain.ts:667`); `deriveServingSignals` (`signals.ts:148`).
- Produces (Task 4 relies on this):
  - `Signals.catalogRetrievalEnabled?: boolean` (new field, `types.ts`).
  - The brain's `retrieval` object shape is now `{ query: string; flags: string[]; enabled: boolean }` (was `{ query; flags }`).
  - `ServingSignalContext.catalogRetrievalEnabled?: boolean` (new field, `signals.ts`).

- [ ] **Step 1: Write the failing brain test**

Create `packages/widget-brain/test/brain-catalog-per-turn.test.ts`. It proves that with the constructor flag OFF (the new production posture), a per-turn `signals.catalogRetrievalEnabled = true` still drives retrieval, and absent/false leaves it on the full-catalog path:

```ts
import { describe, it, expect, vi } from "vitest";
import { createBrain, DEFAULT_POLICY, StaticGroundingAdapter, MockCommerceAdapter } from "../src/index.js";
import type { ModelPort, Signals } from "../src/index.js";
import type { CatalogRetrieverPort } from "../src/types.js";

function fakeModel(): ModelPort {
  return { async complete() { return { text: "sure", model: "fake" }; }, async embed() { throw new Error("unused"); } };
}

describe("brain — CATALOG_RETRIEVAL is a per-turn signal, not a baked-in flag", () => {
  it("consults the retriever when signals.catalogRetrievalEnabled is true even with the constructor flag OFF", async () => {
    const grounding = new StaticGroundingAdapter();
    const retrieve = vi.fn(async () => ({ ctx: await grounding.getContext("demo"), rendered: [], corpusTotal: 3 }));
    const retriever = { retrieve } as unknown as CatalogRetrieverPort;
    // Positions 11 (retriever), 12 (catalogRetrievalEnabled=false — the new prod default), 13 (k).
    const brain = createBrain(fakeModel(), grounding, DEFAULT_POLICY, new MockCommerceAdapter(), "shopper-demo",
      undefined, false, false, false, false, retriever, false, 5);
    const signals: Signals = { tenantId: "demo", catalogRetrievalEnabled: true };
    const d = await brain.decide(signals, "show me a warm winter jacket");
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(d.flags).toContain("retrieval:applied");
  });

  it("does NOT consult the retriever when the per-turn signal is absent (full-catalog path)", async () => {
    const grounding = new StaticGroundingAdapter();
    const retrieve = vi.fn(async () => ({ ctx: await grounding.getContext("demo"), rendered: [], corpusTotal: 3 }));
    const retriever = { retrieve } as unknown as CatalogRetrieverPort;
    const brain = createBrain(fakeModel(), grounding, DEFAULT_POLICY, new MockCommerceAdapter(), "shopper-demo",
      undefined, false, false, false, false, retriever, false, 5);
    const d = await brain.decide({ tenantId: "demo" }, "show me a warm winter jacket");
    expect(retrieve).not.toHaveBeenCalled();
    expect(d.flags).not.toContain("retrieval:applied");
  });
});
```

> NOTE for the implementer: verify the exact `createBrain` positional signature at `packages/widget-brain/src/brain.ts` before writing — positions 11-13 are `catalogRetriever, catalogRetrievalEnabled, catalogRetrievalK` (see `brain.ts:838-852` and the call site `server.ts:692-694`). If `retrieveViaShell`'s returned `flags` label differs from `retrieval:applied`, match `brain.ts:999`.

- [ ] **Step 2: Run the test — verify it fails**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm --filter @palup/widget-brain exec vitest run test/brain-catalog-per-turn.test.ts`
Expected: FAIL — `signals.catalogRetrievalEnabled` is not read; the retriever is gated by the constructor flag (`false`), so the first assertion (`toHaveBeenCalledTimes(1)`) fails.

- [ ] **Step 3: Add the `Signals` field**

In `packages/widget-brain/src/types.ts`, inside `export interface Signals` (starts `:287`), next to `kill?`/`atCap?` (`:342-343`), add:

```ts
  /**
   * S4 §B — per-TURN CATALOG_RETRIEVAL enablement for THIS tenant, resolved server-side from the
   * two-gate registry (state-postgres/catalog-retrieval-enablement.ts) via deriveServingSignals — never
   * client-set, exactly like `kill`/`atCap`. Absent ⇒ the brain falls back to the constructor
   * `catalogRetrievalEnabled` default (which serving now passes as `false`), so retrieval is dark until a
   * tenant is enabled. This REPLACES the retired process-global `process.env.CATALOG_RETRIEVAL`.
   */
  catalogRetrievalEnabled?: boolean;
```

- [ ] **Step 4: Fold the gate into the per-turn `retrieval` object in the brain**

In `packages/widget-brain/src/brain.ts`:

(a) Change the `groundedMessages` `retrieval` parameter type (`:1011`) to carry the enablement:

```ts
    retrieval?: { query: string; flags: string[]; enabled: boolean },
```

(b) Change the retrieval branch (`:1027`) from the closure flag to the per-turn `retrieval.enabled`:

```ts
    if (retrieval?.enabled && catalogRetriever && grounding && retrieval.query.trim() !== "") {
```

(c) In `decide`, immediately after `const flags: string[] = [];` (`:1106`), compute the effective per-turn enablement (Task 4 will edit this same line to AND-in the kill):

```ts
      // S4 §B — retrieval is a PER-TURN decision. `signals.catalogRetrievalEnabled` (server-resolved from
      // the two-gate registry) wins; absent ⇒ the constructor default (serving now passes false). This is
      // what retired the process-global CATALOG_RETRIEVAL flag.
      const catalogRetrievalOn = signals.catalogRetrievalEnabled ?? catalogRetrievalEnabled;
```

(d) At the clean sales-path `groundedMessages` call (`:1737-1749`), replace the retrieval arg `{ query: message, flags }` with:

```ts
          { query: message, flags, enabled: catalogRetrievalOn },
```

(No other call site passes `retrieval`, so support/exit-intent/classifier prompts stay byte-identical.)

- [ ] **Step 5: Run the brain test + the flag-off golden — verify green**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm --filter @palup/widget-brain exec vitest run test/brain-catalog-per-turn.test.ts test/retrieval-flag-off.test.ts test/catalog-retrieval.test.ts`
Expected: PASS — new per-turn behavior works; `retrieval-flag-off.test.ts` byte-identical golden still holds (constructor default false, no signal ⇒ `getContext`); `catalog-retrieval.test.ts` (constructor flag true, no signal ⇒ `true`) still holds.

- [ ] **Step 6: Write the failing serving test**

Create `packages/widget-backend/test/serving-catalog-per-tenant.test.ts`. Assert (i) two tenants in ONE process get different retrieval treatment from the SAME registry, and (ii) no `process.env.CATALOG_RETRIEVAL` read remains in `server.ts` (grep-guard):

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import {
  setCatalogRetrievalPlatformEnabled,
  setCatalogRetrievalTenantOptIn,
  catalogRetrievalEnabledFor,
} from "@palup/state-postgres";

const here = dirname(fileURLToPath(import.meta.url));

describe("serving — per-tenant CATALOG_RETRIEVAL resolution", () => {
  it("resolves true for an opted-in tenant and false for another under the same master", async () => {
    const store = new InMemoryRuntimeStore();
    await setCatalogRetrievalPlatformEnabled(store, true, { reason: "master" });
    await setCatalogRetrievalTenantOptIn(store, "acme", true, { reason: "canary" });
    expect(await catalogRetrievalEnabledFor(store, "acme")).toBe(true);
    expect(await catalogRetrievalEnabledFor(store, "beta")).toBe(false);
  });

  it("no process.env.CATALOG_RETRIEVAL read survives in server.ts (the env is retired — S4 §B)", () => {
    const src = readFileSync(join(here, "..", "src", "server.ts"), "utf8");
    expect(src).not.toMatch(/process\.env\.CATALOG_RETRIEVAL\b/);
  });
});
```

- [ ] **Step 7: Run it — verify the grep-guard fails**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm --filter @palup/widget-backend exec vitest run test/serving-catalog-per-tenant.test.ts`
Expected: the first test PASSES (Task 1 code), the grep-guard FAILS (`process.env.CATALOG_RETRIEVAL` still at `server.ts:586`).

- [ ] **Step 8: Rewire `server.ts` — retire the env, build the retriever unconditionally**

In `packages/widget-backend/src/server.ts`:

(a) Import the resolver — add `catalogRetrievalEnabledFor` to the `@palup/state-postgres` import (`:35`).

(b) Delete the env read at `:586`:

```ts
  const CATALOG_RETRIEVAL = process.env.CATALOG_RETRIEVAL === "true";
```

Keep `CATALOG_RETRIEVAL_K` (`:587`) unchanged.

(c) Build the retriever unconditionally (`:624-630`) — it is stateless infra, dark until a tenant is enabled:

```ts
  // S4 §B — the retriever is constructed UNCONDITIONALLY (the env gate is retired). It reads no manifest
  // and spends nothing until a turn actually retrieves, which only happens when the per-tenant registry
  // enables it (resolved per-request below). Metered under its OWN agentType (embedding vs generation).
  const catalogRetriever = createCatalogRetriever({
    store,
    vector: vectorPort,
    model: createMeteringModelPort(activeModelPort, telemetry, { agentType: CATALOG_RETRIEVAL_AGENT_TYPE }),
  });
```

(d) Remove `CATALOG_RETRIEVAL` from the `wave4On` boot-warning object (`:661`) so a retired flag is not referenced:

```ts
  const wave4On = Object.entries({ PRODUCT_CITATIONS, PRODUCT_CARDS, CART_LINE_ITEMS, SERVER_GUARD_SIGNALS, PRODUCT_FACTS_HYDRATION, OUTGOING_OFFER_CHECK })
    .filter(([, v]) => v)
    .map(([k]) => k);
```

(e) In `brainFor`, position 12 (`:694`) — pass `false` (the constructor default; per-turn `signals` now drives it):

```ts
        catalogRetriever, /* catalogRetrievalEnabled */ false, CATALOG_RETRIEVAL_K, PRODUCT_CITATIONS, PRODUCT_CARDS, CART_LINE_ITEMS,
```

Update the position-12 comment (`:692-694`) to note the flag is now per-turn via `signals.catalogRetrievalEnabled`.

(f) In the `/chat` handler, alongside the existing `const kill = await matchedKill(...)` (`:2112`), resolve per-tenant enablement:

```ts
      // S4 §B — per-tenant CATALOG_RETRIEVAL, resolved from the two-gate registry on the SAME shared store,
      // so a `pnpm catalog:enable` flip propagates to every serving instance. Default OFF for everyone.
      const catalogRetrievalEnabled = await catalogRetrievalEnabledFor(store, tenantId);
```

(g) Thread it into `deriveServingSignals`'s ctx object (`:2274`), next to `kill`/`atCap`:

```ts
        catalogRetrievalEnabled,
```

- [ ] **Step 9: Add the `deriveServingSignals` pass-through**

In `packages/widget-backend/src/signals.ts`:

(a) Add to `ServingSignalContext` (after `atCap?` `:88` region, before `region`):

```ts
  /**
   * S4 §B — whether CATALOG_RETRIEVAL is enabled for this tenant this turn (from the two-gate registry,
   * server-side via `catalogRetrievalEnabledFor`). NEVER client-set (rebuilt here, like kill/atCap).
   */
  catalogRetrievalEnabled?: boolean;
```

(b) In the returned object (next to `atCap:` `:211`), SPREAD it so the key is absent when off (byte-identical to pre-S4):

```ts
    ...(ctx.catalogRetrievalEnabled ? { catalogRetrievalEnabled: true } : {}),
```

- [ ] **Step 10: Run the serving + full brain/backend suites — verify green**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm --filter @palup/widget-backend exec vitest run test/serving-catalog-per-tenant.test.ts && env -u GOOGLE_CLOUD_PROJECT pnpm --filter @palup/widget-brain exec vitest run && env -u GOOGLE_CLOUD_PROJECT pnpm --filter @palup/widget-backend exec vitest run`
Expected: PASS — grep-guard now green; all existing brain + backend tests (including any `server` boot test) still pass.

- [ ] **Step 11: Commit**

```bash
git add packages/widget-brain/src/types.ts packages/widget-brain/src/brain.ts packages/widget-brain/test/brain-catalog-per-turn.test.ts packages/widget-backend/src/signals.ts packages/widget-backend/src/server.ts packages/widget-backend/test/serving-catalog-per-tenant.test.ts package.json
git commit -m "feat(serving): retire process.env.CATALOG_RETRIEVAL; per-tenant enablement resolved per turn (S4 §B; ships dark)"
```

---

## Task 4: Retrieval-scoped kill — degrade to full-catalog, not halt

Read `matchedKill(store, {tenantId, agentType: CATALOG_RETRIEVAL_AGENT_TYPE})` on `/chat`, thread a distinct `catalogRetrievalKilled` signal into the brain, and in the retrieval branch degrade to the full-catalog `getContext` path (NOT a turn halt). Add a `retrieval:killed` audit flag. Arming is the existing `pnpm kill:arm --scope agent:catalog-retrieval` (parses today) — net-new is only the read + degrade.

**Files:**
- Modify: `packages/widget-brain/src/types.ts` (`Signals`)
- Modify: `packages/widget-brain/src/brain.ts` (`catalogRetrievalOn` + `retrieval:killed`)
- Modify: `packages/widget-backend/src/signals.ts`
- Modify: `packages/widget-backend/src/server.ts` (`/chat` kill read)
- Create/extend tests: `packages/widget-brain/test/brain-retrieval-kill.test.ts`

**Interfaces:**
- Consumes (Task 3): `Signals.catalogRetrievalEnabled`, the `catalogRetrievalOn` expression, `retrieval.enabled`.
- Consumes (existing, confirmed): `matchedKill` (`state-postgres/runtime-kill-registry.ts:37`), `CATALOG_RETRIEVAL_AGENT_TYPE = "catalog-retrieval"` (`catalog-retriever.ts:59`). `matchedKill` already handles precedence global > tenant > agent (`:37-51`); `parseKillScope` already accepts `agent:catalog-retrieval` (`kill-switch.ts:110-120`), but note `runKillSwitch` refuses an `agent:` type `!== RUNTIME_AGENT_TYPE` (`kill-switch.ts:206-212`) — arming `agent:catalog-retrieval` from the CLI is out of scope here (this task only READS + degrades; the CLI widening, if wanted, is a separate note in Task 9). For tests, arm via `armKill` directly.
- Produces: `Signals.catalogRetrievalKilled?: boolean`; `ServingSignalContext.catalogRetrievalKilled?: boolean`; decision flag `"retrieval:killed"`.

- [ ] **Step 1: Write the failing brain test**

Create `packages/widget-brain/test/brain-retrieval-kill.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { createBrain, DEFAULT_POLICY, StaticGroundingAdapter, MockCommerceAdapter } from "../src/index.js";
import type { ModelPort, Signals } from "../src/index.js";
import type { CatalogRetrieverPort } from "../src/types.js";

function fakeModel(): ModelPort {
  return { async complete() { return { text: "sure", model: "fake" }; }, async embed() { throw new Error("unused"); } };
}
function brainWith(retrieve: ReturnType<typeof vi.fn>) {
  const grounding = new StaticGroundingAdapter();
  const retriever = { retrieve } as unknown as CatalogRetrieverPort;
  return createBrain(fakeModel(), grounding, DEFAULT_POLICY, new MockCommerceAdapter(), "shopper-demo",
    undefined, false, false, false, false, retriever, false, 5);
}

describe("brain — retrieval-scoped kill degrades to full-catalog, never halts", () => {
  it("enabled + killed ⇒ getContext path, retrieval:killed flagged, retriever NOT consulted, NO turn halt", async () => {
    const retrieve = vi.fn(async () => { throw new Error("must not be called when killed"); });
    const signals: Signals = { tenantId: "demo", catalogRetrievalEnabled: true, catalogRetrievalKilled: true };
    const d = await brainWith(retrieve).decide(signals, "show me a warm winter jacket");
    expect(retrieve).not.toHaveBeenCalled();
    expect(d.flags).toContain("retrieval:killed");
    expect(d.flags).not.toContain("kill_switch"); // NOT the shopper turn-halt
    expect(d.flags).not.toContain("no_autonomous_action");
    expect(d.mode).not.toBe("support"); // a normal sales turn, just full-catalog
  });

  it("enabled + not killed ⇒ retrieval still runs (no false degrade)", async () => {
    const grounding = new StaticGroundingAdapter();
    const retrieve = vi.fn(async () => ({ ctx: await grounding.getContext("demo"), rendered: [], corpusTotal: 3 }));
    const d = await brainWith(retrieve).decide({ tenantId: "demo", catalogRetrievalEnabled: true }, "show me a jacket");
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(d.flags).not.toContain("retrieval:killed");
  });

  it("the SHOPPER turn-halt kill still halts the whole turn (unchanged)", async () => {
    const retrieve = vi.fn(async () => ({ ctx: undefined, rendered: [], corpusTotal: 0 }));
    const d = await brainWith(retrieve).decide({ tenantId: "demo", kill: true, catalogRetrievalEnabled: true }, "hi");
    expect(d.flags).toContain("kill_switch");
    expect(d.escalateToHuman).toBe(true);
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm --filter @palup/widget-brain exec vitest run test/brain-retrieval-kill.test.ts`
Expected: FAIL — `catalogRetrievalKilled` is not read; `retrieve` is called and `retrieval:killed` is absent.

- [ ] **Step 3: Add the `Signals` field**

In `packages/widget-brain/src/types.ts`, immediately after the `catalogRetrievalEnabled?` field added in Task 3:

```ts
  /**
   * S4 §C — an `agent:catalog-retrieval` operator kill is armed for this turn (server-resolved via
   * matchedKill; precedence global>tenant>agent). DISTINCT from `kill`: this degrades retrieval to the
   * full-catalog getContext path (a retrieval-only rollback), it does NOT halt the turn. Never client-set.
   */
  catalogRetrievalKilled?: boolean;
```

- [ ] **Step 4: AND-in the kill + push the audit flag in the brain**

In `packages/widget-brain/src/brain.ts`, edit the `catalogRetrievalOn` line added in Task 3 (`~:1107`) to:

```ts
      // S4 §B/§C — retrieval is per-turn. `signals.catalogRetrievalEnabled` (registry) enables it; an armed
      // `agent:catalog-retrieval` kill (`signals.catalogRetrievalKilled`) DEGRADES it to full-catalog for
      // this turn (retrieval-only rollback, not a turn halt). Record the degrade for the audit log.
      const catalogRetrievalWanted = signals.catalogRetrievalEnabled ?? catalogRetrievalEnabled;
      const catalogRetrievalOn = catalogRetrievalWanted && !signals.catalogRetrievalKilled;
      if (catalogRetrievalWanted && signals.catalogRetrievalKilled) flags.push("retrieval:killed");
```

(The sales-path `groundedMessages` call already passes `enabled: catalogRetrievalOn` from Task 3 — no further edit there.)

- [ ] **Step 5: Add the `deriveServingSignals` pass-through**

In `packages/widget-backend/src/signals.ts`:

(a) Add to `ServingSignalContext`, next to the `catalogRetrievalEnabled?` added in Task 3:

```ts
  /** S4 §C — an `agent:catalog-retrieval` kill is armed for this tenant/agent/globally (matchedKill). */
  catalogRetrievalKilled?: boolean;
```

(b) In the returned object, next to the Task-3 spread:

```ts
    ...(ctx.catalogRetrievalKilled ? { catalogRetrievalKilled: true } : {}),
```

- [ ] **Step 6: Read the retrieval kill in `server.ts`**

In `packages/widget-backend/src/server.ts` `/chat`, next to `const kill = await matchedKill(...)` (`:2112`) and the enablement read added in Task 3:

```ts
      // S4 §C — the retrieval-scoped kill, read alongside the shopper kill. `CATALOG_RETRIEVAL_AGENT_TYPE`
      // ("catalog-retrieval") is the SAME agentType the retriever meters under (server.ts retriever above).
      // matchedKill handles precedence global>tenant>agent. This DEGRADES retrieval; it does not halt.
      const retrievalKill = await matchedKill(store, { tenantId, agentType: CATALOG_RETRIEVAL_AGENT_TYPE });
```

Then in the `deriveServingSignals` ctx object (next to `catalogRetrievalEnabled` from Task 3):

```ts
        catalogRetrievalKilled: Boolean(retrievalKill),
```

- [ ] **Step 7: Run the brain kill test + backend suite — verify green**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm --filter @palup/widget-brain exec vitest run test/brain-retrieval-kill.test.ts && env -u GOOGLE_CLOUD_PROJECT pnpm --filter @palup/widget-backend exec vitest run`
Expected: PASS (3 new brain tests + backend suite green).

- [ ] **Step 8: Commit**

```bash
git add packages/widget-brain/src/types.ts packages/widget-brain/src/brain.ts packages/widget-brain/test/brain-retrieval-kill.test.ts packages/widget-backend/src/signals.ts packages/widget-backend/src/server.ts
git commit -m "feat(serving): retrieval-scoped kill degrades to full-catalog (agent:catalog-retrieval read + brain degrade + retrieval:killed) (S4 §C)"
```

---

## Task 5: eval/shadow at pgvector-scale + recorded evidence

`buildIndexedRetriever` already accepts an injected `store`/`vector` (`retrieval-eval.ts:37-56`, params 4-5, defaulting to in-memory) — so the injectability the spec asks for EXISTS. This task adds (a) a scale-corpus generator, (b) a structured evidence-artifact writer with the §D schema, and (c) a pgvector-testcontainer test proving the harness wires to the real pgvector adapter and emits the artifact shape on the fake-embed path (no real Vertex). The real-Vertex-at-scale run stays the operator's §5 runbook step (Task 9 documents it).

**Files:**
- Modify: `packages/widget-backend/src/retrieval-eval.ts` (add `generateScaleCorpus`)
- Create: `packages/widget-backend/src/retrieval-promotion-evidence.ts` (schema + writer)
- Create: `packages/widget-backend/test/retrieval-promotion-evidence.test.ts` (unit + testcontainer)
- Modify: `package.json` (append the new test to `test:pgvector`)

**Interfaces:**
- Consumes (existing, confirmed): `buildIndexedRetriever(products, model, tenantId?, store?, vector?)` and `gradeRetrieval(c, hits)` from `./retrieval-eval.js`; `RetrievalProduct`, `RetrievalCase` (same file); `PgVectorStore`, `type Sql` from `@palup/state-postgres` (exported — see `catalog-index-pgvector-reconcile.test.ts:11`); `startPgvectorContainer`, `PGVECTOR_AVAILABLE` from `@palup/state-postgres/test/helpers/pgvector-container`; `InMemoryRuntimeStore`, `ModelPort`, `EmbedRequest`, `EmbedResponse` from `@palup/platform-ports`.
- Produces:
  - `generateScaleCorpus(n: number): RetrievalProduct[]` (in `retrieval-eval.ts`)
  - `export interface RetrievalPromotionEvidence { tenantId: string; model: string; dimension: number; corpusSize: number; recallAtK: number; noWrongProduct: number; shadow: { fabricated: number; stale: number; missingProduct: number }; vectorAnn: boolean; at: string }`
  - `writeRetrievalEvidence(ev: RetrievalPromotionEvidence, dir?: string): string` (returns the written path)

- [ ] **Step 1: Write the failing test**

Create `packages/widget-backend/test/retrieval-promotion-evidence.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryRuntimeStore,
  requireEmbedInputs,
  type EmbedRequest,
  type EmbedResponse,
  type ModelPort,
} from "@palup/platform-ports";
import { PgVectorStore, type Sql } from "@palup/state-postgres";
import { startPgvectorContainer, PGVECTOR_AVAILABLE } from "@palup/state-postgres/test/helpers/pgvector-container";
import { buildIndexedRetriever, gradeRetrieval, generateScaleCorpus } from "../src/retrieval-eval.js";
import { writeRetrievalEvidence, type RetrievalPromotionEvidence } from "../src/retrieval-promotion-evidence.js";

const DIMENSION = 32;
/** Deterministic bag-of-words embed so a token match ranks first (no Vertex). */
function fakeModel(): ModelPort {
  return {
    async complete() { throw new Error("unused"); },
    async embed(req: EmbedRequest): Promise<EmbedResponse> {
      requireEmbedInputs(req);
      const vectors = req.texts.map((t) => {
        const v = new Array<number>(DIMENSION).fill(0);
        for (const tok of t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
          let h = 0;
          for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
          v[h % DIMENSION] += 1;
        }
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / norm);
      });
      return { vectors, model: "fake-embed-bow-32", dimension: DIMENSION, purpose: req.purpose };
    },
  };
}

describe("retrieval-promotion — evidence writer + scale corpus", () => {
  it("generateScaleCorpus produces N unique-id products", () => {
    const corpus = generateScaleCorpus(5000);
    expect(corpus.length).toBe(5000);
    expect(new Set(corpus.map((p) => p.id)).size).toBe(5000);
  });

  it("writeRetrievalEvidence emits the §D schema to reports/…json and returns the path", () => {
    const dir = mkdtempSync(join(tmpdir(), "s4-evidence-"));
    try {
      const ev: RetrievalPromotionEvidence = {
        tenantId: "acme", model: "fake-embed-bow-32", dimension: 32, corpusSize: 5000,
        recallAtK: 1, noWrongProduct: 1, shadow: { fabricated: 0, stale: 0, missingProduct: 0 },
        vectorAnn: true, at: new Date().toISOString(),
      };
      const path = writeRetrievalEvidence(ev, dir);
      expect(path).toMatch(/retrieval-promotion-evidence-acme-.*\.json$/);
      const written = JSON.parse(readFileSync(path, "utf8"));
      expect(written).toEqual(ev);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!PGVECTOR_AVAILABLE)("retrieval-promotion — harness wires to real pgvector (fake embed)", () => {
  let sql: Sql;
  let stop: () => Promise<void>;
  beforeAll(async () => {
    ({ sql, stop } = await startPgvectorContainer());
    await new PgVectorStore(sql, { dimension: DIMENSION, efSearch: 40 }).migrate();
  }, 120_000);
  afterAll(async () => { await stop?.(); }, 120_000);

  it("indexes a scale corpus into pgvector, retrieves the token-matching product, grades, writes evidence", async () => {
    await sql.query("TRUNCATE vp_ann");
    const vector = new PgVectorStore(sql, { dimension: DIMENSION, efSearch: 40 });
    const store = new InMemoryRuntimeStore();
    // Seed 3 discriminable products among the synthetic bulk, so the fake bow-embed has a clear top-1.
    const corpus = [
      { id: "p-apple", title: "Crisp Apple", price: "$1", description: "crunchy sweet apple orchard fruit", tags: ["apple"] },
      { id: "p-banana", title: "Ripe Banana", price: "$2", description: "soft yellow banana tropical fruit", tags: ["banana"] },
      ...generateScaleCorpus(200),
    ];
    const { retriever, tenantId } = await buildIndexedRetriever(corpus, fakeModel(), "acme", store, vector);
    const { hits } = await retriever.retrieve({ tenantId, query: "crunchy sweet apple", k: 5 });
    expect(hits[0]?.productId).toBe("p-apple");
    const g = gradeRetrieval({ id: "apple", query: "crunchy sweet apple", expectTop: "p-apple" }, hits);
    expect(g.pass).toBe(true);
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm --filter @palup/widget-backend exec vitest run test/retrieval-promotion-evidence.test.ts`
Expected: FAIL — `generateScaleCorpus` / `writeRetrievalEvidence` not found. (The pgvector block skips if Docker is unavailable — `PGVECTOR_AVAILABLE`.)

- [ ] **Step 3: Add the scale-corpus generator**

Append to `packages/widget-backend/src/retrieval-eval.ts`:

```ts
/**
 * S4 §D — a scale-representative synthetic corpus for the promotion eval/shadow run. `n` products with
 * unique ids and enough token variety that a top-k retriever has real work to do. Used by the operator
 * runbook (pnpm eval:retrieval at the tenant's scale) and by the pgvector wiring test. A real tenant
 * catalog can be used instead — this is the deterministic default.
 */
export function generateScaleCorpus(n: number): RetrievalProduct[] {
  const out: RetrievalProduct[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `gen-${i}`,
      title: `Product ${i}`,
      price: `$${(i % 100) + 1}`,
      description: `synthetic product ${i} in category ${i % 20} with feature ${i % 7}`,
      tags: [`cat-${i % 20}`, `feat-${i % 7}`],
    });
  }
  return out;
}
```

- [ ] **Step 4: Write the evidence writer**

Create `packages/widget-backend/src/retrieval-promotion-evidence.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// S4 §D — the STRUCTURED, retained record the HITL-POLICY §5 per-tenant promotion requires: a recorded
// eval+shadow result on a scale-representative corpus, NOT just stdout + an exit code. The operator's
// real-Vertex-at-scale run (DEPLOY.md runbook) emits one of these before enabling a tenant; the pgvector
// testcontainer test emits the same shape on the fake-embed path to prove the wiring in CI.

export interface RetrievalPromotionEvidence {
  tenantId: string;
  /** Embedding model id the run used (e.g. the Vertex model, or "fake-embed-…" in CI). */
  model: string;
  dimension: number;
  corpusSize: number;
  /** Fraction 0..1 of eval cases whose relevant product appeared in top-k (recall@k). */
  recallAtK: number;
  /** Fraction 0..1 of eval cases with NO clearly-irrelevant product in top-k. */
  noWrongProduct: number;
  /** Shadow violation counts when narrowing the catalog (zero-tolerance safety bars). */
  shadow: { fabricated: number; stale: number; missingProduct: number };
  vectorAnn: boolean;
  /** ISO-8601 timestamp the evidence was produced. */
  at: string;
}

/** Write the evidence to `reports/retrieval-promotion-evidence-<tenant>-<stamp>.json`; returns the path. */
export function writeRetrievalEvidence(ev: RetrievalPromotionEvidence, dir = "reports"): string {
  mkdirSync(dir, { recursive: true });
  const stamp = ev.at.replace(/[:.]/g, "-");
  const path = join(dir, `retrieval-promotion-evidence-${ev.tenantId}-${stamp}.json`);
  writeFileSync(path, JSON.stringify(ev, null, 2));
  return path;
}
```

- [ ] **Step 5: Append the test to `test:pgvector`**

In `package.json`, append `packages/widget-backend/test/retrieval-promotion-evidence.test.ts` to the `test:pgvector` script's file list (keep the step NAME `test:pgvector` unchanged — Global Constraints).

- [ ] **Step 6: Run the unit tests (Docker-optional)**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm --filter @palup/widget-backend exec vitest run test/retrieval-promotion-evidence.test.ts`
Expected: the two non-container tests PASS; the pgvector block runs if Docker is present (PASS) or skips.

- [ ] **Step 7: Run the pgvector gate (if Docker available)**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm test:pgvector`
Expected: PASS including the new file. (If Docker is unavailable, set `PGVECTOR_TESTCONTAINER=off` locally; the merge-gate runs it with Docker.)

- [ ] **Step 8: Commit**

```bash
git add packages/widget-backend/src/retrieval-eval.ts packages/widget-backend/src/retrieval-promotion-evidence.ts packages/widget-backend/test/retrieval-promotion-evidence.test.ts package.json
git commit -m "feat(eval): scale-corpus generator + retrieval-promotion evidence artifact + pgvector wiring test (S4 §D)"
```

---

## Task 6: pgvector-safe `runCatalogClear` (ledger-based, no text-enumerate)

`runCatalogClear` (`catalog-index.ts:1032-1068`) counts before/after via `deps.vector.query(ns, { text: "", k })` (`:1040`, `:1042`) — which THROWS on the S1 pgvector/VECTOR_ANN store. Replace those counts with the ledger (mirrors what S3 did for the index path): the pre-erase count is the ledger size; erasure is `deleteNamespace` + `deleteLedgerInTx`; confirmation is a ledger read-back (empty).

**Files:**
- Modify: `packages/widget-backend/src/jobs/catalog-index.ts` (`runCatalogClear`)
- Create: `packages/widget-backend/test/catalog-clear-pgvector.test.ts`
- Modify: `package.json` (append to `test:pgvector`)

**Interfaces:**
- Consumes (existing, confirmed): `readCorpusLedger(store, tenantId): Promise<Map<string,string>>`, `listLedgerChunkKeys(store, tenantId): Promise<string[]>`, `deleteLedgerInTx(t, priorChunkKeys)` from `./catalog-ledger.js`; `catalogNamespace`, `MANIFEST_COLLECTION`, `MANIFEST_KEY` (this file); `VectorPort.deleteNamespace(ns)`.
- Produces: `runCatalogClear` keeps its signature `(deps: { store; vector; now? }, tenantId): Promise<CatalogClearReport>` and the `CatalogClearReport` shape (`{ tenantId; removed; confirmed; elapsedMs }`) — unchanged, so Task 8's callers are unaffected.

- [ ] **Step 1: Write the failing test**

Create `packages/widget-backend/test/catalog-clear-pgvector.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  InMemoryRuntimeStore,
  requireEmbedInputs,
  type EmbedRequest,
  type EmbedResponse,
  type GroundingContext,
  type ModelPort,
  type Product,
} from "@palup/platform-ports";
import { PgVectorStore, type Sql } from "@palup/state-postgres";
import { startPgvectorContainer, PGVECTOR_AVAILABLE } from "@palup/state-postgres/test/helpers/pgvector-container";
import { runCatalogIndex, runCatalogClear, type CatalogSource } from "../src/jobs/catalog-index.js";
import { listLedgerChunkKeys } from "../src/jobs/catalog-ledger.js";

const DIMENSION = 8;
function fakeModel(): ModelPort {
  return {
    async complete() { return { text: "ok", model: "fake-embed-8d" }; },
    async embed(req: EmbedRequest): Promise<EmbedResponse> {
      requireEmbedInputs(req);
      const vectors = req.texts.map((t) => {
        const v = new Array(DIMENSION).fill(0);
        for (let i = 0; i < t.length; i++) v[i % DIMENSION] += (t.charCodeAt(i) % 5) + 1;
        return v;
      });
      return { vectors, model: "fake-embed-8d", dimension: DIMENSION, purpose: req.purpose };
    },
  };
}
function catalog(n: number): CatalogSource {
  return async (tenantId): Promise<GroundingContext> => {
    const products: Product[] = [];
    for (let i = 0; i < n; i++) products.push({ id: `gid://shopify/Product/${i}`, title: `t-${i}`, description: `d-${i}`, price: "$1", tags: [`x`], availableForSale: true });
    return { tenantId, brandName: "B", products, policy: { returns: "", shipping: "" } };
  };
}

describe.skipIf(!PGVECTOR_AVAILABLE)("runCatalogClear — pgvector-safe (no text-modality query)", () => {
  let sql: Sql;
  let stop: () => Promise<void>;
  beforeAll(async () => {
    ({ sql, stop } = await startPgvectorContainer());
    await new PgVectorStore(sql, { dimension: DIMENSION, efSearch: 40 }).migrate();
  }, 120_000);
  afterAll(async () => { await stop?.(); }, 120_000);

  it("clears an indexed corpus on pgvector without throwing, and erases every ledger chunk", async () => {
    await sql.query("TRUNCATE vp_ann");
    const vector = new PgVectorStore(sql, { dimension: DIMENSION, efSearch: 40 });
    const store = new InMemoryRuntimeStore();
    await runCatalogIndex({ store, vector, model: fakeModel(), catalog: catalog(50) }, ["acme"], {});
    expect((await listLedgerChunkKeys(store, "acme")).length).toBeGreaterThan(0);

    const report = await runCatalogClear({ store, vector }, "acme"); // must NOT throw on pgvector
    expect(report.confirmed).toBe(true);
    expect(report.removed).toBe(50);
    expect(await listLedgerChunkKeys(store, "acme")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `env -u GOOGLE_CLOUD_PROJECT PGVECTOR_TESTCONTAINER=on pnpm --filter @palup/widget-backend exec vitest run test/catalog-clear-pgvector.test.ts`
Expected: FAIL — `runCatalogClear` throws inside `deps.vector.query(ns, { text: "" })` on the pgvector store (text-modality query rejected).

- [ ] **Step 3: Make `runCatalogClear` ledger-based**

In `packages/widget-backend/src/jobs/catalog-index.ts`, replace the body of `runCatalogClear` (`:1036-1067`) with:

```ts
  const ns = catalogNamespace(tenantId);
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const started = Date.now();

  // S4 §F — count via the LEDGER (RuntimeState KV), never a text-modality vector query (which THROWS on
  // the S1 pgvector store). The ledger is the authoritative id set S3 keeps atomically with the manifest.
  const beforeLedger = await readCorpusLedger(deps.store, tenantId);
  const removed = beforeLedger.size;
  const ledgerChunkKeys = await listLedgerChunkKeys(deps.store, tenantId);

  await deps.vector.deleteNamespace(ns);

  await deps.store.tx({ tenantId }, async (t) => {
    await t.delete(MANIFEST_COLLECTION, MANIFEST_KEY);
    await deleteLedgerInTx(t, ledgerChunkKeys);
    await t.audit(
      {
        actor: "operator",
        action: "catalog.clear",
        input: { tenantId, removed },
        decision: "corpus_erased",
        reversalPath: `pnpm catalog:index --tenant ${tenantId} (rebuilds from the current catalog; it does not restore these vectors)`,
      },
      at,
    );
  });

  // CONFIRM via the ledger read-back (the vector store exposes no portable count). The corpus id set is
  // erased iff no ledger chunk survives; deleteNamespace erased the vectors those ids named.
  const afterKeys = await listLedgerChunkKeys(deps.store, tenantId);
  if (afterKeys.length > 0) {
    throw new Error(`clear of ${tenantId}'s catalog corpus did not take effect — ledger chunks remain (${afterKeys.length})`);
  }

  return { tenantId, removed, confirmed: true, elapsedMs: Date.now() - started };
```

- [ ] **Step 4: Run the pgvector test — verify green + no regressions**

Run: `env -u GOOGLE_CLOUD_PROJECT PGVECTOR_TESTCONTAINER=on pnpm --filter @palup/widget-backend exec vitest run test/catalog-clear-pgvector.test.ts && env -u GOOGLE_CLOUD_PROJECT pnpm --filter @palup/widget-backend exec vitest run test/catalog-index-job.test.ts`
Expected: PASS. Check `catalog-index-job.test.ts` for any existing `runCatalogClear` assertion that depended on the removed `vector.query` counts; update it to assert `removed` from the ledger if needed (the in-memory vector store supports `query`, so the old test may still pass — but the count source changed from vector to ledger; reconcile any exact-count expectation).

- [ ] **Step 5: Append the test to `test:pgvector`**

In `package.json`, append `packages/widget-backend/test/catalog-clear-pgvector.test.ts` to the `test:pgvector` file list.

- [ ] **Step 6: Commit**

```bash
git add packages/widget-backend/src/jobs/catalog-index.ts packages/widget-backend/test/catalog-clear-pgvector.test.ts package.json
git commit -m "fix(catalog-index): pgvector-safe runCatalogClear (ledger-based count + confirm, no text-modality query) (S4 §F)"
```

---

## Task 7: Ledger `writtenAt` migration + fetch-timestamp concurrency guard

Extend the ledger chunk with an optional per-entry `writtenAt` (parallel map, so `readCorpusLedger`'s existing `Map<string,string>` return is untouched). The full reconcile (`indexOneTenant`) records `fetchStartedAt` at catalog-fetch time and EXCLUDES from its stale-set any ledger id written after that snapshot (a concurrent webhook created it) — and carries such protected ids forward into the new ledger. Back-compat: an entry read without a `writtenAt` (pre-S4) is treated as `writtenAt = 0`, so it is never spuriously protected. Keep the chunking + atomic-with-manifest properties.

**Files:**
- Modify: `packages/widget-backend/src/jobs/catalog-ledger.ts` (chunk shape + timestamps reader + `chunkLedgerEntries` writtenAt param)
- Modify: `packages/widget-backend/src/jobs/catalog-index.ts` (`indexOneTenant` guard; `writeManifestAndAudit`/`reconcileProducts` writtenAt plumbing)
- Create: `packages/widget-backend/test/catalog-index-concurrency-guard.test.ts`

**Interfaces:**
- Consumes: `readCorpusLedger`, `listLedgerChunkKeys`, `chunkLedgerEntries`, `writeLedgerInTx` (this + `catalog-ledger.ts`), `MANIFEST_COLLECTION` / `MANIFEST_KEY`.
- Produces:
  - `CorpusLedgerChunk` gains `writtenAt?: Record<string, number>` (optional; absent on pre-S4 chunks).
  - `chunkLedgerEntries(entries: Map<string,string>, at: string, writtenAtMs?: number, chunkSize?: number): CorpusLedgerChunk[]` — new 3rd param; when given, every id in the chunk gets that `writtenAt`.
  - `readCorpusLedgerTimestamps(store: RuntimeStatePort, tenantId: string): Promise<Map<string, number>>` — id → writtenAt ms; ids from chunks with no `writtenAt` map to `0`.

- [ ] **Step 1: Write the failing test**

Create `packages/widget-backend/test/catalog-index-concurrency-guard.test.ts`. It simulates a webhook writing product X into the ledger AFTER the full job's fetch snapshot, and asserts the full reconcile does NOT delete X; plus a pre-S4 entry (no `writtenAt`) is still reconciled normally:

```ts
import { describe, it, expect, vi } from "vitest";
import {
  InMemoryRuntimeStore,
  createInMemoryVectorStore,
  requireEmbedInputs,
  type EmbedRequest,
  type EmbedResponse,
  type GroundingContext,
  type ModelPort,
  type Product,
} from "@palup/platform-ports";
import { runCatalogIndex, catalogNamespace, MANIFEST_COLLECTION, type CatalogSource } from "../src/jobs/catalog-index.js";
import { readCorpusLedger, ledgerChunkKey } from "../src/jobs/catalog-ledger.js";

const DIMENSION = 8;
function fakeModel(): ModelPort {
  return {
    async complete() { return { text: "ok", model: "fe" }; },
    async embed(req: EmbedRequest): Promise<EmbedResponse> {
      requireEmbedInputs(req);
      return { vectors: req.texts.map((t) => { const v = new Array(DIMENSION).fill(0); for (let i = 0; i < t.length; i++) v[i % DIMENSION] += 1; return v; }), model: "fe", dimension: DIMENSION, purpose: req.purpose };
    },
  };
}
function products(ids: number[]): Product[] {
  return ids.map((i) => ({ id: `gid://shopify/Product/${i}`, title: `t-${i}`, description: `d-${i}`, price: "$1", tags: ["x"], availableForSale: true }));
}

describe("catalog-index — fetch-timestamp concurrency guard (S4 §F)", () => {
  it("does NOT stale-delete a product a concurrent webhook wrote after the full job's fetch snapshot", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    // Seed: index products 0,1,2 normally so a ledger exists with real writtenAt timestamps.
    const seed: CatalogSource = async (t) => ({ tenantId: t, brandName: "B", products: products([0, 1, 2]), policy: { returns: "", shipping: "" } });
    await runCatalogIndex({ store, vector, model: fakeModel(), catalog: seed, now: () => new Date(1_000) }, ["acme"], {});

    // The full job's fetch returns 0,1,2 (product 9 was NOT yet in the merchant catalog when it fetched).
    // A concurrent webhook writes product 9 into the ledger DURING the run — modeled by a catalog source
    // whose FIRST await injects the ledger write, then returns the pre-webhook snapshot {0,1,2}.
    const ns = catalogNamespace("acme");
    const racingCatalog: CatalogSource = async (t): Promise<GroundingContext> => {
      // webhook wrote product:9 with a writtenAt AFTER the full job's fetchStartedAt (now()=5_000 below).
      const chunk = { version: 1 as const, at: new Date(6_000).toISOString(), entries: { "product:gid://shopify/Product/9": "hash9" }, writtenAt: { "product:gid://shopify/Product/9": 6_000 } };
      // merge onto the existing ledger chunk 0000 (read-modify-write to keep 0,1,2 too)
      const existing = await readCorpusLedger(store, "acme");
      const entries: Record<string, string> = { "product:gid://shopify/Product/9": "hash9" };
      const writtenAt: Record<string, number> = { "product:gid://shopify/Product/9": 6_000 };
      for (const [id, h] of existing) { entries[id] = h; writtenAt[id] = 1_000; }
      await store.put({ tenantId: "acme" }, MANIFEST_COLLECTION, ledgerChunkKey(0), { version: 1, at: chunk.at, entries, writtenAt });
      await vector.upsert(ns, [{ id: "product:gid://shopify/Product/9", vector: new Array(DIMENSION).fill(1), metadata: { kind: "product", productId: "gid://shopify/Product/9", contentHash: "hash9", title: "t-9" } }]);
      return { tenantId: t, brandName: "B", products: products([0, 1, 2]), policy: { returns: "", shipping: "" } };
    };
    const [report] = await runCatalogIndex({ store, vector, model: fakeModel(), catalog: racingCatalog, now: () => new Date(5_000) }, ["acme"], {});
    expect(report!.outcome).not.toBe("failed");
    // product 9 (written after fetchStartedAt=5_000) must survive both the vector store AND the ledger.
    const ledger = await readCorpusLedger(store, "acme");
    expect([...ledger.keys()]).toContain("product:gid://shopify/Product/9");
    expect(report!.removed).toBe(0);
  });

  it("treats a pre-S4 entry (no writtenAt) as writtenAt=0 — still reconcilable, never spuriously protected", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    // Write a pre-S4-shaped ledger chunk (NO writtenAt map) with a delisted product 7.
    await store.put({ tenantId: "acme" }, MANIFEST_COLLECTION, ledgerChunkKey(0), { version: 1, at: new Date(1_000).toISOString(), entries: { "product:gid://shopify/Product/7": "old" } });
    await store.put({ tenantId: "acme" }, MANIFEST_COLLECTION, "manifest", { model: "fe", dimension: DIMENSION, purpose: "document", products: 1, at: new Date(1_000).toISOString(), ceiling: 50000 });
    await vector.upsert(catalogNamespace("acme"), [{ id: "product:gid://shopify/Product/7", vector: new Array(DIMENSION).fill(1), metadata: { kind: "product", productId: "gid://shopify/Product/7", contentHash: "old", title: "t-7" } }]);
    // The current catalog no longer lists 7 → it must be pruned (writtenAt defaults to 0 < fetchStartedAt).
    const catalog: CatalogSource = async (t) => ({ tenantId: t, brandName: "B", products: products([0]), policy: { returns: "", shipping: "" } });
    const [report] = await runCatalogIndex({ store, vector, model: fakeModel(), catalog, now: () => new Date(9_000) }, ["acme"], {});
    const ledger = await readCorpusLedger(store, "acme");
    expect([...ledger.keys()]).not.toContain("product:gid://shopify/Product/7");
    expect(report!.removed).toBe(1);
  });
});
```

> NOTE for the implementer: verify `createInMemoryVectorStore`, `ledgerChunkKey`, and `MANIFEST_COLLECTION` are exported where imported (they are: `platform-ports` index, `catalog-ledger.ts:31`, `catalog-index.ts:154`). Adjust the racing-catalog seam if `deps.catalog` is awaited differently.

- [ ] **Step 2: Run it — verify it fails**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm --filter @palup/widget-backend exec vitest run test/catalog-index-concurrency-guard.test.ts`
Expected: FAIL — the first test: product 9 (written after the snapshot) is stale-deleted (no guard yet). The ledger has no `writtenAt`, so the guard can't run.

- [ ] **Step 3: Extend the ledger chunk shape + add the timestamps reader**

In `packages/widget-backend/src/jobs/catalog-ledger.ts`:

(a) Add `writtenAt` to `CorpusLedgerChunk` (`:22-28`):

```ts
export interface CorpusLedgerChunk {
  version: 1;
  at: string;
  /** recordId (`product:<gid>`) → contentHash. */
  entries: Record<string, string>;
  /** S4 §F — recordId → writtenAt (unix ms). OPTIONAL: absent on pre-S4 chunks (⇒ treated as 0, never
   *  spuriously protected by the concurrency guard). A --reindex rewrites every chunk in the new shape. */
  writtenAt?: Record<string, number>;
}
```

(b) Add the `writtenAtMs` param to `chunkLedgerEntries` (`:77-92`):

```ts
export function chunkLedgerEntries(
  entries: Map<string, string>,
  at: string,
  writtenAtMs?: number,
  chunkSize: number = LEDGER_CHUNK_SIZE,
): CorpusLedgerChunk[] {
  const size = Math.max(1, Math.floor(chunkSize));
  const ids = [...entries.keys()].sort();
  const chunks: CorpusLedgerChunk[] = [];
  for (let i = 0; i < ids.length; i += size) {
    const slice = ids.slice(i, i + size);
    const e: Record<string, string> = Object.create(null);
    const w: Record<string, number> = Object.create(null);
    for (const id of slice) {
      e[id] = entries.get(id)!;
      if (writtenAtMs !== undefined) w[id] = writtenAtMs;
    }
    chunks.push({ version: 1, at, entries: e, ...(writtenAtMs !== undefined ? { writtenAt: w } : {}) });
  }
  return chunks;
}
```

(c) Add the timestamps reader after `readCorpusLedger` (`~:73`):

```ts
/** S4 §F — recordId → writtenAt (unix ms). An id in a chunk with no `writtenAt` map (pre-S4) reads as 0,
 *  so the concurrency guard never protects it. Never touches the vector store. */
export async function readCorpusLedgerTimestamps(store: RuntimeStatePort, tenantId: string): Promise<Map<string, number>> {
  const rows = await store.list<CorpusLedgerChunk>({ tenantId }, MANIFEST_COLLECTION);
  const out = new Map<string, number>();
  for (const { key, value } of rows) {
    if (!key.startsWith(LEDGER_KEY_PREFIX)) continue;
    for (const id of Object.keys(value?.entries ?? {})) out.set(id, value?.writtenAt?.[id] ?? 0);
  }
  return out;
}
```

- [ ] **Step 4: Thread `writtenAt` through the ledger write**

In `packages/widget-backend/src/jobs/catalog-index.ts`, `writeManifestAndAudit` (`:766-800`) — the `at` string is the tx commit time; pass its ms to `chunkLedgerEntries` so every id this tx writes gets a fresh `writtenAt`:

```ts
    await writeLedgerInTx(t, chunkLedgerEntries(ledger.entries, at, new Date(at).getTime()), ledger.priorChunkKeys);
```

(This uniform rule — every entry the tx writes gets `writtenAt = commit time` — is correct for the guard: entries are all older than the NEXT run's `fetchStartedAt`, and a genuinely concurrent webhook write lands with its own later timestamp. `reconcileProducts` (`:965-971`) already calls `writeManifestAndAudit`, so the webhook path picks up `writtenAt` automatically — no separate edit there.)

- [ ] **Step 5: Add the concurrency guard to `indexOneTenant`**

In `packages/widget-backend/src/jobs/catalog-index.ts` `indexOneTenant`:

(a) Record `fetchStartedAt` immediately before the catalog fetch (`:479`):

```ts
  const fetchStartedAt = now().getTime();
  const catalog = await deps.catalog(tenantId);
```

(b) Import `readCorpusLedgerTimestamps` (add to the `catalog-ledger.js` import block, `:43-47`).

(c) After `const ledger = opts.reindex ? new Map... : await readCorpusLedger(...)` (`:549`), read the timestamps (only needed for a non-reindex run):

```ts
  const ledgerWrittenAt = opts.reindex ? new Map<string, number>() : await readCorpusLedgerTimestamps(deps.store, tenantId);
```

(d) Change the stale computation (`:561`) to exclude concurrently-written ids, and collect them so they can be carried forward:

```ts
  // S4 §F — a ledger id absent from this fetch's plan is normally stale (delisted). But an id a CONCURRENT
  // webhook wrote AFTER this job's fetch snapshot (`writtenAt > fetchStartedAt`) is NOT delisted — it is a
  // just-created product the fetch simply predates. Exclude it from the delete set AND carry it forward, so
  // the hourly backstop never deletes a product a webhook created mid-run. Pre-S4 entries read writtenAt=0.
  const staleCandidates = opts.reindex || ledger.size === 0 ? [] : [...ledger.keys()].filter((id) => !wanted.has(id));
  const protectedIds = staleCandidates.filter((id) => (ledgerWrittenAt.get(id) ?? 0) > fetchStartedAt);
  const stale = staleCandidates.filter((id) => (ledgerWrittenAt.get(id) ?? 0) <= fetchStartedAt);
```

(e) When building the new ledger (`:730`), carry the protected ids (with their prior hash) forward alongside the plan:

```ts
  const newLedger = new Map(plan.map((p) => [p.recordId, p.hash]));
  for (const id of protectedIds) newLedger.set(id, ledger.get(id)!); // S4 §F — keep concurrently-created ids
```

(f) Verify the `finalCount` (`:719`) uses `wanted.size` on the non-reindex path — update it to `newLedger.size` so the manifest count includes carried protected ids:

```ts
  const finalCount = opts.reindex ? records.length : newLedger.size;
```

(The `stale` deleteById at `:700` now excludes protected ids automatically. The `manifest.products === ledger.size` fast-path at `:566` still holds because protected ids are already in `ledger` — a concurrent write during a no-op run is rare and self-heals next run.)

- [ ] **Step 6: Run the guard test + the existing ledger/reconcile suites**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm --filter @palup/widget-backend exec vitest run test/catalog-index-concurrency-guard.test.ts test/catalog-ledger.test.ts test/catalog-index-ledger-reconcile.test.ts test/catalog-index-targeted.test.ts`
Expected: PASS. If `catalog-ledger.test.ts` asserts `chunkLedgerEntries(entries, at)` output exactly, update it for the new (still-back-compatible) 2-arg call — 2-arg omits `writtenAt`, so the chunk shape is byte-identical to pre-S4 for the 2-arg path.

- [ ] **Step 7: Run the pgvector reconcile gate (if Docker) — no regression**

Run: `env -u GOOGLE_CLOUD_PROJECT PGVECTOR_TESTCONTAINER=on pnpm --filter @palup/widget-backend exec vitest run test/catalog-index-pgvector-reconcile.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/widget-backend/src/jobs/catalog-ledger.ts packages/widget-backend/src/jobs/catalog-index.ts packages/widget-backend/test/catalog-index-concurrency-guard.test.ts
git commit -m "fix(catalog-index): ledger writtenAt + fetch-timestamp concurrency guard (hourly backstop no longer races a webhook reconcile) (S4 §F)"
```

---

## Task 8: Statutory erasure wiring — `runCatalogClear` into `shop/redact` + `app/uninstalled`

Call `runCatalogClear` (corpus namespace + ledger) from `handleShopRedact`'s erasure path AND `handleAppUninstalled` (`routes/shopify-webhooks.ts`). Now that the corpus + ledger are actually erased, remove those two lines from the `SHOP_REDACT_RESIDUAL` disclosure and update the `app/uninstalled` FIX-5 comment. `app/uninstalled` now destroys data, so gate its clear on the kill switch (NN#4 — a data-destroying action must be haltable), matching `shop/redact`'s existing kill gate. **SECURITY-SENSITIVE — security review REQUIRED (§F, statutory/ADR-0015).**

**Files:**
- Modify: `packages/widget-backend/src/routes/shopify-webhooks.ts`
- Create: `packages/widget-backend/test/shopify-webhooks-catalog-erasure.test.ts`

**Interfaces:**
- Consumes (Task 6, confirmed pgvector-safe): `runCatalogClear(deps: { store; vector; now? }, tenantId): Promise<CatalogClearReport>` from `../jobs/catalog-index.js`.
- Consumes (existing): `ShopifyWebhookDeps` has `store: RuntimeStatePort`, `vector: VectorPort`, `killCheck: (tenantId) => Promise<boolean>`, `now: () => number` (`shopify-webhooks.ts:154-171`).
- Produces: no new exported symbols; the erasure of `<tenantId>::catalog` + ledger becomes a fact the residual list no longer discloses.

- [ ] **Step 1: Write the failing test**

Create `packages/widget-backend/test/shopify-webhooks-catalog-erasure.test.ts`. Index a corpus, deliver a valid `shop/redact` (and separately `app/uninstalled`), and assert the corpus ledger is gone. Reuse the existing test harness pattern from `shopify-webhooks-catalog.test.ts` / `shopify-webhook-routes.test.ts` for building a signed request + `ShopifyWebhookDeps` (read that file first to mirror the HMAC signing + `registerShopifyWebhooks` wiring exactly). Skeleton:

```ts
import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore, createInMemoryVectorStore, requireEmbedInputs, type EmbedRequest, type EmbedResponse, type GroundingContext, type ModelPort, type Product } from "@palup/platform-ports";
import { runCatalogIndex, catalogNamespace, type CatalogSource } from "../src/jobs/catalog-index.js";
import { listLedgerChunkKeys } from "../src/jobs/catalog-ledger.js";
// import the same test helpers shopify-webhook-routes.test.ts uses to build a Fastify app + sign a body.

const DIMENSION = 8;
function fakeModel(): ModelPort { /* identical to Task 6's fakeModel */ return { async complete() { return { text: "ok", model: "fe" }; }, async embed(req: EmbedRequest): Promise<EmbedResponse> { requireEmbedInputs(req); return { vectors: req.texts.map((t) => { const v = new Array(DIMENSION).fill(0); for (let i = 0; i < t.length; i++) v[i % DIMENSION] += 1; return v; }), model: "fe", dimension: DIMENSION, purpose: req.purpose }; } }; }
function catalog(): CatalogSource { return async (t): Promise<GroundingContext> => ({ tenantId: t, brandName: "B", products: [{ id: "gid://shopify/Product/1", title: "t", description: "d", price: "$1", tags: ["x"], availableForSale: true }] as Product[], policy: { returns: "", shipping: "" } }); }

describe("shop/redact + app/uninstalled erase the catalog corpus + ledger (S4 §F)", () => {
  it("shop/redact (not halted) runs runCatalogClear — ledger chunks gone", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    await runCatalogIndex({ store, vector, model: fakeModel(), catalog: catalog() }, ["acme"], {});
    expect((await listLedgerChunkKeys(store, "acme")).length).toBeGreaterThan(0);
    // build deps { store, vector, registry(acme→active), killCheck: async () => false, now, clientSecret },
    // register routes, POST a validly-signed shop/redact body naming acme's shop domain, expect 200.
    // ... (mirror shopify-webhook-routes.test.ts's signing + resolveTenant seam) ...
    expect(await listLedgerChunkKeys(store, "acme")).toEqual([]);
  });

  it("app/uninstalled runs runCatalogClear when not halted; SKIPS it (leaves the corpus) when a kill is armed", async () => {
    // two sub-cases: killCheck async () => false ⇒ ledger erased; killCheck async () => true ⇒ ledger retained.
  });
});
```

> NOTE for the implementer: `shopify-webhook-routes.test.ts` and `shopify-webhooks-catalog.test.ts` already build a signed request + `ShopifyWebhookDeps` + register the routes. Copy that setup verbatim rather than reinventing HMAC signing. Assert erasure via `listLedgerChunkKeys(store, tenantId) === []` (a portable check that does not query the vector store).

- [ ] **Step 2: Run it — verify it fails**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm --filter @palup/widget-backend exec vitest run test/shopify-webhooks-catalog-erasure.test.ts`
Expected: FAIL — the handlers do not call `runCatalogClear`; the ledger survives.

- [ ] **Step 3: Wire `runCatalogClear` into `handleShopRedact`**

In `packages/widget-backend/src/routes/shopify-webhooks.ts`, import at the top:

```ts
import { runCatalogClear } from "../jobs/catalog-index.js";
```

In `handleShopRedact`'s NON-halted erasure path, after `await eraseIndexedSubjects(deps, tenantId);` (`:559`) and before/around the `trimStream` block, add:

```ts
  // S4 §F — erase the catalog corpus namespace + its corpus-state ledger (ADR-0015). runCatalogClear is
  // pgvector-safe (S4 Task 6 — ledger-based, no text-modality query). Fail-safe: an erase failure is
  // logged, and the audit row above already refuses to claim completeness. Idempotent: if app/uninstalled
  // already cleared it, the ledger is empty and this is a no-op (removed:0).
  try {
    await runCatalogClear({ store: deps.store, vector: deps.vector, now: () => new Date(deps.now()) }, tenantId);
  } catch (e) {
    console.error(`[shop/redact] catalog corpus clear failed tenant=${tenantId}: ${(e as Error).message}`);
  }
```

(The shop/redact erasure is ALREADY kill-gated at the top of the handler — `deps.killCheck` defers the whole erasure — so this call only runs when not halted.)

- [ ] **Step 4: Wire `runCatalogClear` into `handleAppUninstalled` (kill-gated)**

In `handleAppUninstalled`, after `await deps.registry.setStatus(tenantId, "uninstalled", { reason });` (`:366`), add:

```ts
  // S4 §F — an uninstalled merchant should stop being groundable: erase the catalog corpus + ledger. This
  // is now a DATA-DESTROYING action, so unlike the status write it is kill-gated (NN#4 — a destructive
  // action must be haltable). When halted, skip it: the hourly index job is halted too, and shop/redact
  // (48h later) erases it. Fail-safe + idempotent (removed:0 if already cleared).
  if (!(await deps.killCheck(tenantId))) {
    try {
      await runCatalogClear({ store: deps.store, vector: deps.vector, now: () => new Date(deps.now()) }, tenantId);
    } catch (e) {
      console.error(`[app/uninstalled] catalog corpus clear failed tenant=${tenantId}: ${(e as Error).message}`);
    }
  }
```

- [ ] **Step 5: Update the disclosures**

In `SHOP_REDACT_RESIDUAL` (`:470-484`), DELETE the two entries that named the catalog corpus + ledger as un-erased gaps (`:481-482`) and their FIX-5 comment (`:475-480`). In `handleShopRedact`'s audit `decision.erased` array (`:547`), add `"the catalog corpus namespace + its corpus-state ledger"`. Update the `handleAppUninstalled` FIX-5 comment (`:313-316`) to state the corpus/ledger ARE now erased here (kill-gated).

- [ ] **Step 6: Run the erasure test + the full webhook suite**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm --filter @palup/widget-backend exec vitest run test/shopify-webhooks-catalog-erasure.test.ts test/shopify-webhook-routes.test.ts test/shopify-webhooks-catalog.test.ts`
Expected: PASS. Any existing test asserting `notErased` CONTAINS the catalog corpus/ledger strings must be updated to assert their ABSENCE (they are now erased).

- [ ] **Step 7: Security review**

Run the `security-reviewer` subagent on the diff (statutory erasure + a new data-destroying path on `app/uninstalled`). Resolve any finding before merge. Confirm: (a) erasure remains haltable at every scope (NN#4); (b) no cross-tenant erase (`runCatalogClear` is scoped to `<tenantId>::catalog`); (c) idempotency; (d) the audit row does not overclaim completeness.

- [ ] **Step 8: Commit**

```bash
git add packages/widget-backend/src/routes/shopify-webhooks.ts packages/widget-backend/test/shopify-webhooks-catalog-erasure.test.ts
git commit -m "feat(shopify-webhooks): erase catalog corpus+ledger on shop/redact + app/uninstalled (kill-gated); close the SHOP_REDACT_RESIDUAL gap (S4 §F)"
```

---

## Task 9: #295 amendment — HITL-POLICY §5 + ADR-0020 (docs)

The two compensating controls #295's canary waiver assumed now EXIST; the stale "1000-product ceiling" caveat is wrong. Amend `docs/HITL-POLICY.md` §5's `CATALOG_RETRIEVAL` block + `docs/adr/0020-durable-grounding-at-scale.md` to cite the new controls and state the per-tenant promotion bar. Recommend closing #295 as superseded. No code tests (docs); the merge-gate governance-no-weakening guard applies — this is an ADDITIVE amendment (controls added, a stale caveat corrected), so no gate is weakened.

**Files:**
- Modify: `docs/HITL-POLICY.md` (§5 `CATALOG_RETRIEVAL` block, ~`:120`, `:159-197`)
- Modify: `docs/adr/0020-durable-grounding-at-scale.md`
- Modify: `docs/DEPLOY.md` (the operator §5 runbook for the real-Vertex-at-scale evidence run)

- [ ] **Step 1: Read the current §5 CATALOG_RETRIEVAL block**

Read `docs/HITL-POLICY.md` around the `CATALOG_RETRIEVAL` block and `docs/adr/0020-durable-grounding-at-scale.md` in full, so the amendment reconciles the existing text rather than restating it (per the operating-manual's "leave already-correct docs untouched" rule).

- [ ] **Step 2: Amend HITL-POLICY §5**

In the `CATALOG_RETRIEVAL` block, add/adjust prose (match the file's existing voice; do not cosmetically rewrite correct text):

- The two compensating controls now EXIST: per-tenant staged enablement via `packages/state-postgres/src/catalog-retrieval-enablement.ts` + `pnpm catalog:enable --scope tenant:<id> --on` (platform master + per-tenant opt-in, both default OFF), and the retrieval-scoped Kill Switch — an `agent:catalog-retrieval` kill is now READ on `/chat` (`matchedKill(..., {agentType: CATALOG_RETRIEVAL_AGENT_TYPE})`) and DEGRADES retrieval to the full-catalog path (an instant, retrieval-only rollback).
- Fix the stale ceiling caveat: the index ceiling is now `MAX_INDEXED_PRODUCTS = 50000` (`catalog-index.ts:135`); serving-fetch stays 1000 (`MAX_CATALOG_PRODUCTS`); a corpus above ~5000 requires `VECTOR_ANN` (pgvector HNSW).
- State the per-tenant promotion bar: a recorded real-Vertex `pnpm eval:retrieval` pass + `pnpm shadow:retrieval` pass (the structured evidence artifact `reports/retrieval-promotion-evidence-<tenant>-<stamp>.json`, `retrieval-promotion-evidence.ts`) + a named-owner sign-off, with an Audit Log entry at each per-tenant `catalog:enable` flip (the registry audits atomically).

- [ ] **Step 3: Amend ADR-0020**

Record that S4 completes A2: the enablement registry + CLI, the retrieval-scoped kill read+degrade, the pgvector-safe clear, the concurrency guard, and the statutory-erasure wiring all landed; `CATALOG_RETRIEVAL` is now promotable per-tenant. Note #295 is superseded (S4 carries the corrected amendment). Correct any 1000-ceiling reference the same way as §2.

- [ ] **Step 4: Add the operator runbook to DEPLOY.md**

Document the §5 per-tenant promotion procedure: (1) run `pnpm eval:retrieval` + `pnpm shadow:retrieval` with real Vertex + real pgvector (`VECTOR_ANN=true`) at the tenant's scale (a real catalog or `generateScaleCorpus`), producing the evidence artifact; (2) named-owner reviews the artifact; (3) `pnpm catalog:enable --scope platform --on` (once) then `--scope tenant:<id> --on --reason "<name>: promoting after eval/shadow evidence <path>"`; (4) rollback is `pnpm kill:arm --scope agent:catalog-retrieval` (degrade) or `pnpm catalog:enable --scope tenant:<id> --off`.

- [ ] **Step 5: Recommend closing #295**

In the S4 PR body, note: "#295 is superseded — S4 carries the corrected amendment (the two compensating controls now exist). Recommend closing #295." Do not close it from a build agent; the named human owner does that on merge.

- [ ] **Step 6: Commit**

```bash
git add docs/HITL-POLICY.md docs/adr/0020-durable-grounding-at-scale.md docs/DEPLOY.md
git commit -m "docs(governance): S4 amendment — cite the two compensating controls, fix the stale ceiling, state the per-tenant promotion bar; #295 superseded (S4 §E)"
```

---

## Final verification (before opening the PR)

- [ ] Run the full local gate: `env -u GOOGLE_CLOUD_PROJECT bash scripts/merge-gate.sh` (all five/seven steps green — the seven step names unchanged). Then `env -u GOOGLE_CLOUD_PROJECT PGVECTOR_TESTCONTAINER=on pnpm test:pgvector` with Docker (the new pgvector files run).
- [ ] Confirm ships-dark: no `CATALOG_RETRIEVAL`/`VECTOR_ANN`/`MEMORY_ADR_ACCEPTED`/`PRODUCT_FACTS_HYDRATION` flip anywhere in the diff; the enablement master + all opt-ins default OFF; the grep-guard (Task 3) is green.
- [ ] `security-reviewer` pass on §B/§C/§F (Tasks 3, 4, 8) resolved.
- [ ] Open the PR stating: touches the RUN-TIME plane (shopper agent behavior + statutory erasure), crosses HITL boundaries (§B enablement, §C kill, §F erasure), **governance-touching → human-merged by jason.hsu**, and recommends closing #295.

---

## Self-Review (run after writing; findings fixed inline)

**Spec coverage — every §B–§H requirement maps to a task:**

- §B per-tenant enablement registry (master + opt-in, both OFF, audited setters) → **Task 1**. `pnpm catalog:enable` CLI (mirror kill-switch, refuse unknown scope, print state) → **Task 2**. Serving: retire env, build retriever unconditionally, resolve per-tenant per-turn, thread into brain handling the cache correctly, flag-off goldens byte-identical, grep-guard → **Task 3**. Gate truth-table / CLI-writes-registry+audit / per-tenant-threading / no-env-read tests → **Tasks 1, 2, 3**. ✓
- §C retrieval-scoped kill: read `matchedKill(agent:catalog-retrieval)` on `/chat`, `catalogRetrievalKilled` signal, brain degrade to `getContext`, `retrieval:killed` flag, arm via existing CLI, tests (killed→getContext / normal unaffected / shopper halt still halts) → **Task 4**. ✓
- §D injectable pgvector store/vector (already present — noted), scale-corpus generator, evidence artifact writer with the exact schema, runbook, CI testcontainer on fake-embed, tests → **Task 5** (runbook prose in **Task 9**). ✓
- §E #295 amendment (HITL-POLICY §5 + ADR-0020, controls now exist, fix stale ceiling, per-tenant bar, recommend closing #295) → **Task 9**. ✓
- §F pgvector-safe `runCatalogClear` → **Task 6**; statutory erasure wiring into `shop/redact` + `app/uninstalled` + `SHOP_REDACT_RESIDUAL` update + security review → **Task 8**; ledger `writtenAt` migration + fetch-timestamp concurrency guard + back-compat + interleaving test → **Task 7**. ✓
- §G testing & governance (ATDD, `env -u`, mock+pgvector-only, ships dark, no VectorPort change, portability, human-merged, seven step names, security review) → **Global Constraints + per-task steps + Final verification**. ✓
- §H outcome (promotable per-tenant with instant retrieval-scoped rollback) → the sum of Tasks 1-9; stated in Task 9 DEPLOY runbook. ✓

**Placeholder scan:** No "TBD"/"similar to Task N"/"add error handling". Task 8's test uses a documented skeleton because it must reuse the existing webhook signing harness verbatim (reading `shopify-webhook-routes.test.ts` is a real, named step) — the assertions and imports are concrete; the HMAC-signing boilerplate is deliberately delegated to the existing helper rather than reproduced wrongly. Every code step ships real code.

**Type/signature consistency across tasks:** `catalogRetrievalEnabledFor(store, tenantId)` (Task 1) is the exact symbol Tasks 2 & 3 import. `Signals.catalogRetrievalEnabled` (Task 3) precedes `Signals.catalogRetrievalKilled` (Task 4). The brain `retrieval` object is `{ query; flags; enabled }` after Task 3 and unchanged by Task 4 (Task 4 only edits the `catalogRetrievalOn` expression + pushes a flag). `runCatalogClear`'s signature/return is unchanged by Task 6, so Task 8's calls match. `chunkLedgerEntries`'s new 3rd param `writtenAtMs?` (Task 7) is optional, so existing 2-arg callers and the `catalog-ledger.test.ts` 2-arg assertions stay valid. `readCorpusLedgerTimestamps` (Task 7) is consumed only within Task 7. `CatalogEnableScope`/`CatalogEnableCommand` (Task 2) are self-contained.

**One flagged design nuance (not a spec gap):** Task 8 makes `app/uninstalled` a data-destroying path; the plan gates that clear on `deps.killCheck` to preserve NN#4 (the spec says "call runCatalogClear from app/uninstalled" but is silent on the kill gate). This is an additive safety choice, explicitly routed to the required §F security review — recorded here so the reviewer confirms it rather than discovering it.
