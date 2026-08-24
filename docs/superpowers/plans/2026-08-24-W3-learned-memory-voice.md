# W3 · Learned / Memory & Voice — Implementation Plan

**Goal.** Build the moat surface: a per-tenant **Learned store** the merchant reads and teaches, a
governed **insight synthesizer** that only surfaces conservatively-grounded insights, an **agent-proposes /
merchant-owns** voice mechanism (agent may PROPOSE a voice change via the W1 loop, never silently alters
voice), and the **two-tier learning** mechanism with a **hard wall** — private per-merchant (live on
staging) + aggregate anonymized cross-merchant priors (mechanism built, **OFF** behind a double gate,
zero live callers, pending legal/security). Console screen at `src/screens/learned/`. All build-dark:
mechanisms real on the staging shape, every §3 enablement deferred, honest empty / "still measuring"
states — never the mockup's fabricated numbers.

**Architecture.** Follows the existing merchant-console program split exactly:
- **Port + in-memory adapter + contract** in `@palup/platform-ports` (`learned-store.ts`,
  `aggregate-priors.ts`, `contract/learned-store.contract.ts`) — pure, dependency-free, the swappable seam.
- **Durable adapter** in `@palup/state-postgres` (`learned-store.ts`, own table + idempotent `migrate()`),
  audited via the shared `RuntimeStatePort` — the exact `PostgresMerchantRulesStore` pattern.
- **Engine producers** in `@palup/agent-runtime` (`insight-synthesizer.ts`, `voice.ts`) — reuse
  `proposeOrExecute` (the W1 spine) and the grounding gate from the port; no new autonomy.
- **Merchant-plane routes** in `@palup/merchant-backend` (`routes/learned.ts` + two staging triggers),
  registered **inside** the authenticated `merchantPlane`, tenant-scoped from `req.principal.merchantId`,
  RBAC per route, added to the structural route-protection guard.
- **Console** in `@palup/merchant-console` (`app/api.ts` methods + `screens/learned/`), replacing the
  `/learned` stub, taking `{ api }`, using only `@palup/design-system` primitives.

**Tech Stack.** TypeScript (ESM), Fastify, vitest, React + Vite + Tailwind + `@palup/design-system`,
Postgres via `state-postgres` (testcontainer-gated). pnpm monorepo. No provider SDK in feature code
(portability, ADR-0001).

**Spec:** `docs/superpowers/specs/2026-08-23-merchant-console-and-agent-runtime-design.md` (§9 W3 is the
binding authority; §10 Learning ledger; §11 build order block 4; §12 non-negotiables; §13 aggregate-wall risk).

## Global Constraints (copied from the spec's non-negotiables, §12 + §3)

- **Money/model/business-model never auto-applies** → a voice/behavior change the *agent* wants becomes a
  W1 **Proposal** (`proposeOrExecute`), never a silent write. Merchant-authored voice/policy edits are
  per-tenant config (direct, audited) — that is the merchant's own act, not agent autonomy.
- **No agent ships to prod without eval gate + human promotion.** The insight synthesizer runs on staging
  (per §6.3, agents may reach canary on staging traffic); its prod promotion + eval-gate wiring is a
  **deferred human gate**, not built here.
- **Portability** → all cloud access via ports; no provider SDK in feature code.
- **Kill Switch always works** → producers go through `proposeOrExecute`, which already calls
  `assertNotKilled` before creating a proposal; nothing here adds a path an operator cannot stop.
- **Every autonomous action audited** → every store mutation and every producer action writes the
  append-only, hash-chained ledger via `RuntimeStatePort.audit`.
- **Least privilege** → GETs are `console.view` (every role); teach/pin/delete are `learned.edit`
  (manager+); staging triggers are `agent.operate` (operator+).
- **Never render fake state.** The console shows real API data with honest empty / "still measuring"
  states; it deliberately omits the mockup's fabricated counts (3,104 orders, 96% voice match, …).
- **Two-tier hard wall.** The aggregate layer's ADR-accepted const is `false` (double gate, memory
  pattern), it has **zero live callers**, and the private→aggregate anonymizer strips every tenant
  identifier. Enabling it is a legal/security review (§13), never a build flip.
- **Special-category insights respect the consent path.** Insight text is classified with
  `classifyFact` (widget-memory); a `special` insight is flagged and its prod-enablement stays
  memory-legal-gated (ADR-0015). Governance-touching edits are out of scope — flagged as deferred gates.

---

## Task 1 — LearnedStore port + grounding gate + safety floor + in-memory adapter

Build the private-layer port: the `LearnedInsight` model, the conservative-grounding gate
(`gradeInsight`), the teaching safety floor (`isSafetyFloorViolation`), the `LearnedStore` interface, the
`InMemoryLearnedStore` (audits every mutation internally, like `InMemoryMerchantRulesStore`), and the
adapter contract every impl must pass.

**Files**
- create `packages/platform-ports/src/learned-store.ts`
- create `packages/platform-ports/src/contract/learned-store.contract.ts`
- modify `packages/platform-ports/src/index.ts` (barrel export)
- create `packages/platform-ports/test/learned-store.test.ts`

**Interfaces**
- Consumes: `RuntimeStateCtx`, `RuntimeStatePort` (from `./runtime-state-port.js`).
- Produces (exact):
  ```ts
  export type LearnedCategory = "customers" | "products" | "voice" | "policies";
  export type LearnedTier = "private" | "aggregate";
  export type LearnedOrigin = "synthesized" | "merchant_taught";
  export type ConfidenceTier = "medium" | "high"; // "low" is never surfaced — it is a drop, not a value

  export interface LearnedGrounding { source: string; sampleSize: number; confidence: ConfidenceTier; }
  export interface LearnedInsight {
    id: string; tenantId: string; category: LearnedCategory; tier: LearnedTier;
    origin: LearnedOrigin; text: string; grounding: LearnedGrounding;
    pinned: boolean; createdAt: string; updatedAt: string;
  }
  export interface InsightCandidate { category: LearnedCategory; text: string; source: string; sampleSize: number; }
  export type GroundingVerdict = { surface: false; reason: string } | { surface: true; confidence: ConfidenceTier };
  export function gradeInsight(candidate: InsightCandidate): GroundingVerdict;
  export type TeachingStance = "tighten" | "loosen";
  export const SAFETY_CRITICAL_GUARDRAILS: ReadonlySet<string>;
  export function isSafetyFloorViolation(guardrailKey: string, stance: TeachingStance): boolean;
  export interface LearnedListFilter { category?: LearnedCategory; tier?: LearnedTier; }
  export class LearnedInsightNotFoundError extends Error { readonly id: string }
  export interface LearnedStore {
    list(ctx: RuntimeStateCtx, filter?: LearnedListFilter): Promise<LearnedInsight[]>;
    get(ctx: RuntimeStateCtx, id: string): Promise<LearnedInsight | null>;
    record(ctx: RuntimeStateCtx, insight: LearnedInsight, by: string): Promise<LearnedInsight>;
    setPinned(ctx: RuntimeStateCtx, id: string, pinned: boolean, by: string, at: string): Promise<LearnedInsight>;
    remove(ctx: RuntimeStateCtx, id: string, by: string, at: string): Promise<void>;
  }
  export class InMemoryLearnedStore implements LearnedStore { constructor(store: RuntimeStatePort) }
  export const INSIGHT_SURFACE_MIN_SAMPLE = 30;
  export const INSIGHT_HIGH_CONFIDENCE_MIN_SAMPLE = 200;
  export function learnedStoreContract(makeStore: () => LearnedStore | Promise<LearnedStore>): void;
  ```

**Step 1 — write the failing test** `packages/platform-ports/test/learned-store.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  InMemoryLearnedStore, InMemoryRuntimeStore, gradeInsight, isSafetyFloorViolation,
  INSIGHT_SURFACE_MIN_SAMPLE, INSIGHT_HIGH_CONFIDENCE_MIN_SAMPLE,
  learnedStoreContract, LearnedInsightNotFoundError, type LearnedInsight,
} from "../src/index.js";

function insight(over: Partial<LearnedInsight> = {}): LearnedInsight {
  return {
    id: "l1", tenantId: "t1", category: "customers", tier: "private", origin: "synthesized",
    text: "First-time buyers convert more with a sample add-on",
    grounding: { source: "orders", sampleSize: 250, confidence: "high" },
    pinned: false, createdAt: "2026-08-24T00:00:00Z", updatedAt: "2026-08-24T00:00:00Z", ...over,
  };
}

describe("gradeInsight (conservative grounding)", () => {
  it("drops an insight below the surface sample floor", () => {
    expect(gradeInsight({ category: "customers", text: "x", source: "orders", sampleSize: INSIGHT_SURFACE_MIN_SAMPLE - 1 }))
      .toEqual({ surface: false, reason: expect.stringContaining("below floor") });
  });
  it("surfaces at medium below the high floor and high at/above it", () => {
    expect(gradeInsight({ category: "customers", text: "x", source: "orders", sampleSize: 50 })).toEqual({ surface: true, confidence: "medium" });
    expect(gradeInsight({ category: "customers", text: "x", source: "orders", sampleSize: INSIGHT_HIGH_CONFIDENCE_MIN_SAMPLE })).toEqual({ surface: true, confidence: "high" });
  });
  it("drops an insight with no grounding source or empty text", () => {
    expect(gradeInsight({ category: "customers", text: "x", source: "  ", sampleSize: 999 }).surface).toBe(false);
    expect(gradeInsight({ category: "customers", text: "  ", source: "orders", sampleSize: 999 }).surface).toBe(false);
  });
});

describe("isSafetyFloorViolation (teaching safety floor)", () => {
  it("rejects loosening a safety-critical guardrail, allows tightening it", () => {
    expect(isSafetyFloorViolation("refund_cap", "loosen")).toBe(true);
    expect(isSafetyFloorViolation("refund_cap", "tighten")).toBe(false);
  });
  it("allows both directions for a non-safety guardrail key", () => {
    expect(isSafetyFloorViolation("email_signoff", "loosen")).toBe(false);
    expect(isSafetyFloorViolation("email_signoff", "tighten")).toBe(false);
  });
});

describe("InMemoryLearnedStore", () => {
  const ctx = { tenantId: "t1" };
  it("records, lists newest-first, filters by category, and audits", async () => {
    const rt = new InMemoryRuntimeStore();
    const s = new InMemoryLearnedStore(rt);
    await s.record(ctx, insight({ id: "a", category: "customers", createdAt: "2026-08-24T00:00:00Z" }), "owner");
    await s.record(ctx, insight({ id: "b", category: "voice", createdAt: "2026-08-24T01:00:00Z" }), "owner");
    const all = await s.list(ctx);
    expect(all.map((i) => i.id)).toEqual(["b", "a"]);
    expect((await s.list(ctx, { category: "voice" })).map((i) => i.id)).toEqual(["b"]);
    const audit = await rt.readAudit(ctx);
    expect(audit.some((r) => r.action === "learned.recorded")).toBe(true);
  });
  it("the aggregate tier is never served from the private store (hard wall)", async () => {
    const s = new InMemoryLearnedStore(new InMemoryRuntimeStore());
    await s.record(ctx, insight({ id: "a" }), "owner");
    expect(await s.list(ctx, { tier: "aggregate" })).toEqual([]);
  });
  it("isolates tenants", async () => {
    const s = new InMemoryLearnedStore(new InMemoryRuntimeStore());
    await s.record(ctx, insight({ id: "a" }), "owner");
    expect(await s.list({ tenantId: "other" })).toEqual([]);
  });
  it("toggles pin and removes, throwing on a missing id", async () => {
    const s = new InMemoryLearnedStore(new InMemoryRuntimeStore());
    await s.record(ctx, insight({ id: "a", pinned: false }), "owner");
    expect((await s.setPinned(ctx, "a", true, "owner", "2026-08-24T02:00:00Z")).pinned).toBe(true);
    await s.remove(ctx, "a", "owner", "2026-08-24T03:00:00Z");
    expect(await s.get(ctx, "a")).toBeNull();
    await expect(s.setPinned(ctx, "missing", true, "owner", "t")).rejects.toBeInstanceOf(LearnedInsightNotFoundError);
    await expect(s.remove(ctx, "missing", "owner", "t")).rejects.toBeInstanceOf(LearnedInsightNotFoundError);
  });
});

// Prove the shared contract passes against the in-memory adapter (Postgres reuses it in Task 3).
learnedStoreContract(() => new InMemoryLearnedStore(new InMemoryRuntimeStore()));
```

**Step 2 — run, expect fail** (`learned-store.js` does not exist):
`pnpm --filter @palup/platform-ports exec vitest run test/learned-store.test.ts` → red.

**Step 3 — minimal impl** `packages/platform-ports/src/learned-store.ts`:
```ts
import type { RuntimeStateCtx, RuntimeStatePort } from "./runtime-state-port.js";

export type LearnedCategory = "customers" | "products" | "voice" | "policies";
export type LearnedTier = "private" | "aggregate";
export type LearnedOrigin = "synthesized" | "merchant_taught";
export type ConfidenceTier = "medium" | "high";

export interface LearnedGrounding { source: string; sampleSize: number; confidence: ConfidenceTier; }
export interface LearnedInsight {
  id: string; tenantId: string; category: LearnedCategory; tier: LearnedTier;
  origin: LearnedOrigin; text: string; grounding: LearnedGrounding;
  pinned: boolean; createdAt: string; updatedAt: string;
}

export interface InsightCandidate { category: LearnedCategory; text: string; source: string; sampleSize: number; }
export type GroundingVerdict = { surface: false; reason: string } | { surface: true; confidence: ConfidenceTier };

/** Below this observation count an insight is NOT surfaced at all — a wrong insight acted on burns trust
 *  (spec §10, "conservative grounding"). Between this and the high floor it surfaces at "medium". */
export const INSIGHT_SURFACE_MIN_SAMPLE = 30;
/** At/above this an insight may earn "high" confidence. Deliberately generous — mirrors the spirit of
 *  attribution's `MIN_EXPOSURES_PER_ARM` (200) floor: a headline claim needs a real sample behind it. */
export const INSIGHT_HIGH_CONFIDENCE_MIN_SAMPLE = 200;

/** The conservative grounding gate the insight synthesizer runs BEFORE anything is surfaced. No source,
 *  empty text, or sub-floor sample size ⇒ dropped (never a fabricated "high" over thin data). */
export function gradeInsight(c: InsightCandidate): GroundingVerdict {
  if (!c.text.trim()) return { surface: false, reason: "empty insight text" };
  if (!c.source.trim()) return { surface: false, reason: "no grounding source" };
  if (c.sampleSize < INSIGHT_SURFACE_MIN_SAMPLE)
    return { surface: false, reason: `sample size ${c.sampleSize} below floor ${INSIGHT_SURFACE_MIN_SAMPLE}` };
  return { surface: true, confidence: c.sampleSize >= INSIGHT_HIGH_CONFIDENCE_MIN_SAMPLE ? "high" : "medium" };
}

export type TeachingStance = "tighten" | "loosen";

/** PalUp safety-critical guardrails a merchant teaching may only TIGHTEN, never loosen below policy
 *  (spec §10 "safety floor: can tighten guardrails, cannot loosen a safety-critical one"). Seeded from
 *  the real inviolable floors: the mass-send/refund/discount ceilings (`PALUP_FLOORS`,
 *  merchant-rules-store.ts) and widget-brain's SAFETY groups (medical/allergen answers). */
export const SAFETY_CRITICAL_GUARDRAILS: ReadonlySet<string> = new Set([
  "mass_send_floor", "refund_cap", "discount_depth", "medical_safety_answer", "allergen_disclosure",
]);

export function isSafetyFloorViolation(guardrailKey: string, stance: TeachingStance): boolean {
  return stance === "loosen" && SAFETY_CRITICAL_GUARDRAILS.has(guardrailKey);
}

export interface LearnedListFilter { category?: LearnedCategory; tier?: LearnedTier; }

export class LearnedInsightNotFoundError extends Error {
  constructor(public readonly id: string) { super(`learned insight ${id}: not found`); this.name = "LearnedInsightNotFoundError"; }
}

/** Tenant-scoped store for a merchant's PRIVATE learned layer. Every mutation audits internally (NN#5),
 *  same obligation `MerchantRulesStore` carries — there is no single engine-loop call site that owns it.
 *  The aggregate tier lives in a SEPARATE store (`aggregate-priors.ts`) and is never served from here —
 *  the hard wall is structural, not a filter. */
export interface LearnedStore {
  list(ctx: RuntimeStateCtx, filter?: LearnedListFilter): Promise<LearnedInsight[]>;
  get(ctx: RuntimeStateCtx, id: string): Promise<LearnedInsight | null>;
  record(ctx: RuntimeStateCtx, insight: LearnedInsight, by: string): Promise<LearnedInsight>;
  setPinned(ctx: RuntimeStateCtx, id: string, pinned: boolean, by: string, at: string): Promise<LearnedInsight>;
  remove(ctx: RuntimeStateCtx, id: string, by: string, at: string): Promise<void>;
}

const COLLECTION = "learned_private";

function newestFirst(a: LearnedInsight, b: LearnedInsight): number {
  return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
}

export class InMemoryLearnedStore implements LearnedStore {
  constructor(private readonly store: RuntimeStatePort) {}

  async list(ctx: RuntimeStateCtx, filter?: LearnedListFilter): Promise<LearnedInsight[]> {
    // The private store NEVER serves the aggregate tier — that is a different store entirely (hard wall).
    if ((filter?.tier ?? "private") !== "private") return [];
    const rows = await this.store.list<LearnedInsight>(ctx, COLLECTION);
    let items = rows.map((r) => r.value);
    if (filter?.category) items = items.filter((i) => i.category === filter.category);
    return items.sort(newestFirst);
  }

  async get(ctx: RuntimeStateCtx, id: string): Promise<LearnedInsight | null> {
    return this.store.get<LearnedInsight>(ctx, COLLECTION, id);
  }

  async record(ctx: RuntimeStateCtx, insight: LearnedInsight, by: string): Promise<LearnedInsight> {
    await this.store.put(ctx, COLLECTION, insight.id, insight);
    await this.store.audit(ctx, {
      actor: by, action: "learned.recorded",
      input: { id: insight.id, category: insight.category, origin: insight.origin, source: insight.grounding.source },
      decision: { confidence: insight.grounding.confidence, sampleSize: insight.grounding.sampleSize, tier: insight.tier },
      reversalPath: `LearnedStore.remove(ctx, "${insight.id}", by, at) deletes this insight for tenant ${ctx.tenantId}`,
    }, insight.updatedAt);
    return insight;
  }

  async setPinned(ctx: RuntimeStateCtx, id: string, pinned: boolean, by: string, at: string): Promise<LearnedInsight> {
    const cur = await this.store.get<LearnedInsight>(ctx, COLLECTION, id);
    if (!cur) throw new LearnedInsightNotFoundError(id);
    const next: LearnedInsight = { ...cur, pinned, updatedAt: at };
    await this.store.put(ctx, COLLECTION, id, next);
    await this.store.audit(ctx, {
      actor: by, action: "learned.pinned", input: { id, pinned }, decision: { was: cur.pinned },
      reversalPath: `LearnedStore.setPinned(ctx, "${id}", ${cur.pinned}, by, at) restores the prior pin state`,
    }, at);
    return next;
  }

  async remove(ctx: RuntimeStateCtx, id: string, by: string, at: string): Promise<void> {
    const cur = await this.store.get<LearnedInsight>(ctx, COLLECTION, id);
    if (!cur) throw new LearnedInsightNotFoundError(id);
    await this.store.delete(ctx, COLLECTION, id);
    await this.store.audit(ctx, {
      actor: by, action: "learned.removed", input: { id, category: cur.category, origin: cur.origin }, decision: { removed: true },
      reversalPath: `irreversible delete — re-teach via LearnedStore.record to restore it for tenant ${ctx.tenantId}`,
    }, at);
  }
}
```
Create the contract `packages/platform-ports/src/contract/learned-store.contract.ts` (mirrors
`merchant-rules.contract.ts` — one exported fn taking a fresh-store factory):
```ts
import { describe, it, expect } from "vitest";
import type { RuntimeStateCtx } from "../runtime-state-port.js";
import { LearnedInsightNotFoundError, type LearnedInsight, type LearnedStore } from "../learned-store.js";

const ctx: RuntimeStateCtx = { tenantId: "t1" };
function insight(over: Partial<LearnedInsight> = {}): LearnedInsight {
  return {
    id: "l1", tenantId: "t1", category: "customers", tier: "private", origin: "synthesized",
    text: "insight", grounding: { source: "orders", sampleSize: 250, confidence: "high" },
    pinned: false, createdAt: "2026-08-24T00:00:00Z", updatedAt: "2026-08-24T00:00:00Z", ...over,
  };
}
export function learnedStoreContract(makeStore: () => LearnedStore | Promise<LearnedStore>): void {
  describe("LearnedStore contract", () => {
    it("records and reads back", async () => {
      const s = await makeStore();
      await s.record(ctx, insight({ id: "a" }), "owner");
      expect((await s.get(ctx, "a"))?.text).toBe("insight");
    });
    it("filters by category and never serves the aggregate tier", async () => {
      const s = await makeStore();
      await s.record(ctx, insight({ id: "a", category: "voice" }), "owner");
      await s.record(ctx, insight({ id: "b", category: "products" }), "owner");
      expect((await s.list(ctx, { category: "voice" })).map((i) => i.id)).toEqual(["a"]);
      expect(await s.list(ctx, { tier: "aggregate" })).toEqual([]);
    });
    it("pins, removes, isolates tenants, and throws on a missing id", async () => {
      const s = await makeStore();
      await s.record(ctx, insight({ id: "a", pinned: false }), "owner");
      expect((await s.setPinned(ctx, "a", true, "owner", "2026-08-24T02:00:00Z")).pinned).toBe(true);
      expect(await s.list({ tenantId: "other" })).toEqual([]);
      await s.remove(ctx, "a", "owner", "2026-08-24T03:00:00Z");
      expect(await s.get(ctx, "a")).toBeNull();
      await expect(s.remove(ctx, "gone", "owner", "t")).rejects.toBeInstanceOf(LearnedInsightNotFoundError);
    });
  });
}
```
Add to `packages/platform-ports/src/index.ts` (new `export {…}`/`export type {…}` block, mirroring the
merchant-rules block):
```ts
export type {
  LearnedCategory, LearnedTier, LearnedOrigin, ConfidenceTier, LearnedGrounding, LearnedInsight,
  InsightCandidate, GroundingVerdict, TeachingStance, LearnedListFilter, LearnedStore,
} from "./learned-store.js";
export {
  gradeInsight, isSafetyFloorViolation, SAFETY_CRITICAL_GUARDRAILS,
  INSIGHT_SURFACE_MIN_SAMPLE, INSIGHT_HIGH_CONFIDENCE_MIN_SAMPLE,
  InMemoryLearnedStore, LearnedInsightNotFoundError,
} from "./learned-store.js";
export { learnedStoreContract } from "./contract/learned-store.contract.js";
```
Confirm `contract/learned-store.contract.js` resolves through the package's `./contract/*` export
condition (the pattern `@palup/platform-ports/contract/merchant-rules` already uses — check
`packages/platform-ports/package.json` `exports`; if contract files are only surfaced via subpath, export
`learnedStoreContract` from there instead of the barrel to match `merchant-rules`).

**Step 4 — run, expect pass:** `pnpm --filter @palup/platform-ports exec vitest run test/learned-store.test.ts` → green.

**Step 5 — commit:** `feat(platform-ports): LearnedStore port + grounding gate + safety floor (W3, dark)`.

---

## Task 2 — Two-tier aggregate mechanism (hard wall, OFF behind a double gate, zero live callers)

Build the aggregate cross-merchant prior mechanism as a real, tested seam that is **structurally walled
off** from the private layer and **cannot be enabled by an env var alone** (memory's double-gate pattern:
an ADR-accepted const, currently `false`). The private→aggregate anonymizer strips every tenant
identifier; reads are k-anonymity-floored and gated off. **No code in this plan calls `contribute`** — the
wall is that the aggregate layer has zero live producers until legal/security clears it (§13).

**Files**
- create `packages/platform-ports/src/aggregate-priors.ts`
- modify `packages/platform-ports/src/index.ts`
- create `packages/platform-ports/test/aggregate-priors.test.ts`

**Interfaces**
- Consumes: `LearnedInsight`, `LearnedCategory`, `ConfidenceTier`, `gradeInsight` (Task 1); `createHmac`
  from `node:crypto` (a one-way contributor tag — no provider SDK, portable stdlib).
- Produces (exact):
  ```ts
  export const AGGREGATE_LEARNING_ADR_ACCEPTED: boolean; // false — OFF pending legal/security (§13)
  export function isAggregateLearningEnabled(env?: NodeJS.ProcessEnv): boolean;
  export const MIN_CONTRIBUTING_MERCHANTS = 5; // k-anonymity floor before a prior is readable
  export interface AggregatePriorContribution { category: LearnedCategory; text: string; sampleSize: number; contributorTag: string; }
  export function anonymizePrivateInsight(insight: LearnedInsight, secret: string): AggregatePriorContribution;
  export interface AggregatePrior { category: LearnedCategory; text: string; sampleSize: number; contributingMerchants: number; confidence: ConfidenceTier; }
  export interface AggregatePriorStore {
    contribute(insight: LearnedInsight, secret: string): Promise<void>;
    readPriors(filter?: { category?: LearnedCategory }): Promise<AggregatePrior[]>;
  }
  export class InMemoryAggregatePriorStore implements AggregatePriorStore {
    constructor(opts?: { isEnabled?: () => boolean });
  }
  ```

**Step 1 — write the failing test** `packages/platform-ports/test/aggregate-priors.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  anonymizePrivateInsight, isAggregateLearningEnabled, AGGREGATE_LEARNING_ADR_ACCEPTED,
  InMemoryAggregatePriorStore, MIN_CONTRIBUTING_MERCHANTS, type LearnedInsight,
} from "../src/index.js";

function insight(over: Partial<LearnedInsight> = {}): LearnedInsight {
  return {
    id: "l1", tenantId: "t1", category: "customers", tier: "private", origin: "synthesized",
    text: "First-time buyers convert more with a sample add-on",
    grounding: { source: "orders", sampleSize: 250, confidence: "high" },
    pinned: true, createdAt: "2026-08-24T00:00:00Z", updatedAt: "2026-08-24T00:00:00Z", ...over,
  };
}

describe("the aggregate layer is OFF by construction (double gate)", () => {
  it("stays disabled even with the env flag set — the ADR const is false", () => {
    expect(AGGREGATE_LEARNING_ADR_ACCEPTED).toBe(false);
    expect(isAggregateLearningEnabled({ AGGREGATE_LEARNING_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe(false);
  });
  it("readPriors returns [] while disabled, regardless of contributions (dark)", async () => {
    const s = new InMemoryAggregatePriorStore(); // default: real (hard-off) gate
    for (let i = 0; i < MIN_CONTRIBUTING_MERCHANTS + 1; i++) await s.contribute(insight({ tenantId: `t${i}` }), "secret");
    expect(await s.readPriors()).toEqual([]);
  });
});

describe("the hard wall: anonymization strips every tenant identifier", () => {
  it("keeps only category/text/sampleSize + a non-reversible contributor tag", () => {
    const c = anonymizePrivateInsight(insight(), "secret");
    expect(Object.keys(c).sort()).toEqual(["category", "contributorTag", "sampleSize", "text"]);
    expect(c.contributorTag).not.toContain("t1");
    expect(c).not.toHaveProperty("tenantId");
    expect(c).not.toHaveProperty("id");
    expect(c).not.toHaveProperty("pinned");
    // Same tenant → same tag (dedup), different tenant → different tag (distinct-count).
    expect(anonymizePrivateInsight(insight({ tenantId: "t1" }), "secret").contributorTag)
      .toBe(anonymizePrivateInsight(insight({ tenantId: "t1", id: "x" }), "secret").contributorTag);
    expect(anonymizePrivateInsight(insight({ tenantId: "t2" }), "secret").contributorTag)
      .not.toBe(anonymizePrivateInsight(insight({ tenantId: "t1" }), "secret").contributorTag);
  });
});

describe("k-anonymity floor (exercised with an injected enabled gate — never enabled in prod)", () => {
  it("sums sampleSize, counts distinct contributors, and hides priors below the floor", async () => {
    const s = new InMemoryAggregatePriorStore({ isEnabled: () => true });
    // Same text from < floor distinct tenants → hidden.
    for (let i = 0; i < MIN_CONTRIBUTING_MERCHANTS - 1; i++) await s.contribute(insight({ tenantId: `t${i}`, grounding: { source: "orders", sampleSize: 100, confidence: "high" } }), "secret");
    expect(await s.readPriors()).toEqual([]);
    // Add contributors to clear the floor.
    for (let i = MIN_CONTRIBUTING_MERCHANTS - 1; i < MIN_CONTRIBUTING_MERCHANTS + 1; i++) await s.contribute(insight({ tenantId: `t${i}`, grounding: { source: "orders", sampleSize: 100, confidence: "high" } }), "secret");
    const priors = await s.readPriors();
    expect(priors).toHaveLength(1);
    expect(priors[0].contributingMerchants).toBe(MIN_CONTRIBUTING_MERCHANTS + 1);
    expect(priors[0].sampleSize).toBe((MIN_CONTRIBUTING_MERCHANTS + 1) * 100);
    expect(priors[0].confidence).toBe("high"); // aggregate sample well above the high floor
    expect(priors[0]).not.toHaveProperty("contributorTag"); // never leaked out
  });
  it("dedups repeat contributions from the same tenant (no k-anon inflation)", async () => {
    const s = new InMemoryAggregatePriorStore({ isEnabled: () => true });
    for (let i = 0; i < MIN_CONTRIBUTING_MERCHANTS + 1; i++) await s.contribute(insight({ tenantId: "t1" }), "secret");
    expect(await s.readPriors()).toEqual([]); // one distinct contributor < floor
  });
});
```

**Step 2 — run, expect fail** (`aggregate-priors.js` missing) → red.

**Step 3 — minimal impl** `packages/platform-ports/src/aggregate-priors.ts`:
```ts
import { createHmac } from "node:crypto";
import { gradeInsight, type ConfidenceTier, type LearnedCategory, type LearnedInsight } from "./learned-store.js";

/** The aggregate cross-merchant layer's build-time gate — memory's double-gate pattern (flag.ts): even
 *  with `AGGREGATE_LEARNING_ENABLED=true`, this const being `false` keeps it OFF. Flipping it is a
 *  legal/security review (spec §13: the private↔aggregate boundary needs a rigorous "aggregate enough" +
 *  competitive-fairness definition first), a named-human code change — NEVER a build agent's, NEVER a
 *  side effect of other work. */
export const AGGREGATE_LEARNING_ADR_ACCEPTED = false;

export function isAggregateLearningEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGGREGATE_LEARNING_ENABLED === "true" && AGGREGATE_LEARNING_ADR_ACCEPTED;
}

/** k-anonymity floor: a prior is not readable until at least this many DISTINCT merchants contributed the
 *  same insight — so no single store's specifics can be reverse-identified from a prior. The exact value
 *  and the whole readability rule are part of the deferred legal/security review; this is a conservative
 *  placeholder for the mechanism. */
export const MIN_CONTRIBUTING_MERCHANTS = 5;

export interface AggregatePriorContribution { category: LearnedCategory; text: string; sampleSize: number; contributorTag: string; }

/** The hard wall in one function: reduce a private `LearnedInsight` to ONLY the fields an aggregate prior
 *  may carry — category, text, sampleSize — plus a one-way HMAC of the tenant id used solely to count
 *  DISTINCT contributors for k-anonymity (never reversible to the tenant, never surfaced in a read). No
 *  id, tenantId, source, pins, or timestamps cross. */
export function anonymizePrivateInsight(insight: LearnedInsight, secret: string): AggregatePriorContribution {
  return {
    category: insight.category,
    text: insight.text,
    sampleSize: insight.grounding.sampleSize,
    contributorTag: createHmac("sha256", secret).update(insight.tenantId).digest("hex"),
  };
}

export interface AggregatePrior { category: LearnedCategory; text: string; sampleSize: number; contributingMerchants: number; confidence: ConfidenceTier; }

export interface AggregatePriorStore {
  contribute(insight: LearnedInsight, secret: string): Promise<void>;
  readPriors(filter?: { category?: LearnedCategory }): Promise<AggregatePrior[]>;
}

interface Bucket { category: LearnedCategory; text: string; totalSample: number; contributors: Set<string>; }

/** In-memory aggregate store — the tested MECHANISM. Production reads are hard-off (`isAggregateLearningEnabled`
 *  ⇒ false via the ADR const); the `isEnabled` inject exists ONLY so the k-anon/dedup logic can be unit-tested,
 *  never as a runtime enable path. Keyed by (category, normalized text). */
export class InMemoryAggregatePriorStore implements AggregatePriorStore {
  private readonly buckets = new Map<string, Bucket>();
  private readonly isEnabled: () => boolean;
  constructor(opts: { isEnabled?: () => boolean } = {}) { this.isEnabled = opts.isEnabled ?? (() => isAggregateLearningEnabled()); }

  async contribute(insight: LearnedInsight, secret: string): Promise<void> {
    const c = anonymizePrivateInsight(insight, secret);
    const key = `${c.category}::${c.text.trim().toLowerCase()}`;
    const b = this.buckets.get(key) ?? { category: c.category, text: c.text, totalSample: 0, contributors: new Set<string>() };
    // Dedup by contributor tag: a repeat from the same tenant adds sample only if new — keep it simple and
    // count each distinct tenant once for BOTH the k-anon floor and the sample sum (no inflation).
    if (!b.contributors.has(c.contributorTag)) { b.contributors.add(c.contributorTag); b.totalSample += c.sampleSize; }
    this.buckets.set(key, b);
  }

  async readPriors(filter?: { category?: LearnedCategory }): Promise<AggregatePrior[]> {
    if (!this.isEnabled()) return []; // dark: no cross-merchant prior is ever read while disabled
    const out: AggregatePrior[] = [];
    for (const b of this.buckets.values()) {
      if (filter?.category && b.category !== filter.category) continue;
      if (b.contributors.size < MIN_CONTRIBUTING_MERCHANTS) continue; // k-anon floor
      const verdict = gradeInsight({ category: b.category, text: b.text, source: "aggregate", sampleSize: b.totalSample });
      if (!verdict.surface) continue;
      out.push({ category: b.category, text: b.text, sampleSize: b.totalSample, contributingMerchants: b.contributors.size, confidence: verdict.confidence });
    }
    return out;
  }
}
```
Add barrel exports for the new symbols (types + values) to `index.ts`.

**Step 4 — run, expect pass** → green. **Step 5 — commit:**
`feat(platform-ports): aggregate cross-merchant priors mechanism — hard wall, OFF (W3, dark)`.

---

## Task 3 — PostgresLearnedStore (durable private layer)

The durable twin of `InMemoryLearnedStore`, mirroring `PostgresMerchantRulesStore` exactly: own narrow
table, idempotent `migrate()`, SERIALIZABLE mutations, audit via the injected `RuntimeStatePort` (so the
hash-chain lands in the same `rs_audit`), injectable `now` clock. Passes the same `learnedStoreContract`.

**Files**
- create `packages/state-postgres/src/learned-store.ts`
- modify `packages/state-postgres/src/index.ts` (export `PostgresLearnedStore`)
- create `packages/state-postgres/test/learned-store.test.ts`

**Interfaces**
- Consumes: `LearnedStore`, `LearnedInsight`, `LearnedListFilter`, `LearnedInsightNotFoundError`,
  `RuntimeStateCtx`, `RuntimeStatePort` (`@palup/platform-ports`); `Sql` (`./sql.js`).
- Produces: `class PostgresLearnedStore implements LearnedStore { constructor(sql: Sql, state: RuntimeStatePort, opts?: { now?: () => string }); migrate(): Promise<void> }`.

**Step 1 — write the failing test** `packages/state-postgres/test/learned-store.test.ts` (mirrors
`merchant-rules-store.test.ts`: `describe.skipIf(!PGVECTOR_AVAILABLE)`, testcontainer boot, reuse
`learnedStoreContract`, and one direct audit-lands-in-rs_audit assertion):
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { learnedStoreContract } from "@palup/platform-ports/contract/learned-store"; // or from the barrel if that is how Task 1 exported it
import { type RuntimeStatePort } from "@palup/platform-ports";
import { PGVECTOR_AVAILABLE, startPgvectorContainer } from "./helpers/pgvector-container.js";
import type { Sql } from "../src/sql.js";
import { PostgresRuntimeStore } from "../src/postgres-runtime-store.js";
import { PostgresLearnedStore } from "../src/learned-store.js";

describe.skipIf(!PGVECTOR_AVAILABLE)("PostgresLearnedStore", () => {
  let sql: Sql; let stop: () => Promise<void>; let runtimeStore: PostgresRuntimeStore;
  beforeAll(async () => {
    ({ sql, stop } = await startPgvectorContainer());
    runtimeStore = new PostgresRuntimeStore(sql); await runtimeStore.migrate();
    await new PostgresLearnedStore(sql, runtimeStore).migrate();
  }, 120_000);
  afterAll(async () => { await stop?.(); });

  learnedStoreContract(async () => {
    await sql.query("TRUNCATE pl_learned_insight");
    return new PostgresLearnedStore(sql, runtimeStore);
  });

  it("records an audit row in rs_audit for a recorded insight", async () => {
    await sql.query("TRUNCATE pl_learned_insight");
    const store: RuntimeStatePort = runtimeStore;
    const s = new PostgresLearnedStore(sql, runtimeStore);
    await s.record({ tenantId: "t9" }, {
      id: "a", tenantId: "t9", category: "voice", tier: "private", origin: "merchant_taught",
      text: "no exclamation marks in apologies", grounding: { source: "merchant_taught", sampleSize: 0, confidence: "high" },
      pinned: false, createdAt: "2026-08-24T00:00:00Z", updatedAt: "2026-08-24T00:00:00Z",
    }, "owner");
    expect((await store.readAudit({ tenantId: "t9" })).some((r) => r.action === "learned.recorded")).toBe(true);
  });
});
```

**Step 2 — run, expect fail** (skips cleanly when Docker is off; red where available).

**Step 3 — minimal impl** `packages/state-postgres/src/learned-store.ts` (following the
`PostgresMerchantRulesStore` header discipline — own table, mutate-then-audit, bound `$n` params only):
```ts
import {
  LearnedInsightNotFoundError, type LearnedInsight, type LearnedListFilter, type LearnedStore,
  type RuntimeStateCtx, type RuntimeStatePort,
} from "@palup/platform-ports";
import type { Sql } from "./sql.js";

interface Row {
  tenant_id: string; id: string; category: string; tier: string; origin: string; text: string;
  source: string; sample_size: number; confidence: string; pinned: boolean; created_at: string; updated_at: string;
}
const COLUMNS = "tenant_id, id, category, tier, origin, text, source, sample_size, confidence, pinned, created_at, updated_at";

function requireTenant(t: string): string { if (!t?.trim()) throw new Error("LearnedStore: a non-blank tenantId is required (tenant isolation)"); return t; }
function toInsight(r: Row): LearnedInsight {
  return {
    id: r.id, tenantId: r.tenant_id, category: r.category as LearnedInsight["category"], tier: r.tier as LearnedInsight["tier"],
    origin: r.origin as LearnedInsight["origin"], text: r.text,
    grounding: { source: r.source, sampleSize: r.sample_size, confidence: r.confidence as LearnedInsight["grounding"]["confidence"] },
    pinned: r.pinned, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export class PostgresLearnedStore implements LearnedStore {
  private readonly now: () => string;
  constructor(private readonly sql: Sql, private readonly state: RuntimeStatePort, opts: { now?: () => string } = {}) {
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  /** CHECK-guards restate the union literals (never interpolated from a module-private TS union) so a
   *  stray writer can't smuggle an un-vetted category/tier/origin/confidence — same discipline as
   *  `pl_merchant_rules.provenance`. */
  async migrate(): Promise<void> {
    await this.sql.query(
      `CREATE TABLE IF NOT EXISTS pl_learned_insight (
         tenant_id text NOT NULL CHECK (btrim(tenant_id) <> ''),
         id text NOT NULL,
         category text NOT NULL CHECK (category IN ('customers','products','voice','policies')),
         tier text NOT NULL CHECK (tier IN ('private','aggregate')),
         origin text NOT NULL CHECK (origin IN ('synthesized','merchant_taught')),
         text text NOT NULL,
         source text NOT NULL,
         sample_size integer NOT NULL,
         confidence text NOT NULL CHECK (confidence IN ('medium','high')),
         pinned boolean NOT NULL,
         created_at text NOT NULL,
         updated_at text NOT NULL,
         PRIMARY KEY (tenant_id, id))`,
    );
  }

  async list(ctx: RuntimeStateCtx, filter?: LearnedListFilter): Promise<LearnedInsight[]> {
    if ((filter?.tier ?? "private") !== "private") return []; // hard wall — aggregate never lives here
    const tenantId = requireTenant(ctx.tenantId);
    const params: unknown[] = [tenantId];
    let where = "tenant_id = $1";
    if (filter?.category) { params.push(filter.category); where += ` AND category = $${params.length}`; }
    const { rows } = await this.sql.query<Row>(`SELECT ${COLUMNS} FROM pl_learned_insight WHERE ${where} ORDER BY created_at DESC`, params);
    return rows.map(toInsight);
  }

  async get(ctx: RuntimeStateCtx, id: string): Promise<LearnedInsight | null> {
    const { rows } = await this.sql.query<Row>(`SELECT ${COLUMNS} FROM pl_learned_insight WHERE tenant_id = $1 AND id = $2`, [requireTenant(ctx.tenantId), id]);
    return rows[0] ? toInsight(rows[0]) : null;
  }

  async record(ctx: RuntimeStateCtx, insight: LearnedInsight, by: string): Promise<LearnedInsight> {
    const tenantId = requireTenant(ctx.tenantId);
    await this.sql.query(
      `INSERT INTO pl_learned_insight (${COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (tenant_id, id) DO UPDATE SET category=EXCLUDED.category, tier=EXCLUDED.tier, origin=EXCLUDED.origin,
         text=EXCLUDED.text, source=EXCLUDED.source, sample_size=EXCLUDED.sample_size, confidence=EXCLUDED.confidence,
         pinned=EXCLUDED.pinned, updated_at=EXCLUDED.updated_at`,
      [tenantId, insight.id, insight.category, insight.tier, insight.origin, insight.text,
       insight.grounding.source, insight.grounding.sampleSize, insight.grounding.confidence, insight.pinned, insight.createdAt, insight.updatedAt],
    );
    await this.state.audit({ tenantId }, {
      actor: by, action: "learned.recorded",
      input: { id: insight.id, category: insight.category, origin: insight.origin, source: insight.grounding.source },
      decision: { confidence: insight.grounding.confidence, sampleSize: insight.grounding.sampleSize, tier: insight.tier },
      reversalPath: `LearnedStore.remove(ctx, "${insight.id}", by, at) deletes this insight for tenant ${tenantId}`,
    }, insight.updatedAt);
    return insight;
  }

  async setPinned(ctx: RuntimeStateCtx, id: string, pinned: boolean, by: string, at: string): Promise<LearnedInsight> {
    const tenantId = requireTenant(ctx.tenantId);
    const updated = await this.sql.tx(async (tx) => {
      const { rows } = await tx.query<Row>(`SELECT ${COLUMNS} FROM pl_learned_insight WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
      if (!rows[0]) throw new LearnedInsightNotFoundError(id);
      await tx.query(`UPDATE pl_learned_insight SET pinned = $3, updated_at = $4 WHERE tenant_id = $1 AND id = $2`, [tenantId, id, pinned, at]);
      return { was: rows[0].pinned, next: { ...toInsight(rows[0]), pinned, updatedAt: at } };
    });
    await this.state.audit({ tenantId }, {
      actor: by, action: "learned.pinned", input: { id, pinned }, decision: { was: updated.was },
      reversalPath: `LearnedStore.setPinned(ctx, "${id}", ${updated.was}, by, at) restores the prior pin state`,
    }, at);
    return updated.next;
  }

  async remove(ctx: RuntimeStateCtx, id: string, by: string, at: string): Promise<void> {
    const tenantId = requireTenant(ctx.tenantId);
    const prior = await this.sql.tx(async (tx) => {
      const { rows } = await tx.query<Row>(`SELECT ${COLUMNS} FROM pl_learned_insight WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
      if (!rows[0]) throw new LearnedInsightNotFoundError(id);
      await tx.query(`DELETE FROM pl_learned_insight WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
      return rows[0];
    });
    await this.state.audit({ tenantId }, {
      actor: by, action: "learned.removed", input: { id, category: prior.category, origin: prior.origin }, decision: { removed: true },
      reversalPath: `irreversible delete — re-teach via LearnedStore.record to restore it for tenant ${tenantId}`,
    }, at);
  }
}
```
Export `PostgresLearnedStore` from `packages/state-postgres/src/index.ts`.

**Step 4 — run, expect pass** (`PGVECTOR_TESTCONTAINER=off` exits 0; green where Docker available).
**Step 5 — commit:** `feat(state-postgres): PostgresLearnedStore (durable private layer, W3)`.

---

## Task 4 — merchant-backend `/learned` routes + composition wiring + route guard

The merchant-facing surface: `GET /learned?category=`, `POST /learned` (teach, safety-floored),
`POST /learned/:id/pin`, `DELETE /learned/:id`, `GET /learned/export`. Registered inside `merchantPlane`,
tenant from `req.principal.merchantId`, RBAC per route, mapped to a safe DTO (audit.ts discipline), added
to the structural route-protection guard.

**Files**
- create `packages/merchant-backend/src/routes/learned.ts`
- modify `packages/merchant-backend/src/server.ts` (compose `learnedStore`, import + call `registerLearnedRoutes`)
- modify `packages/merchant-backend/test/route-protection.test.ts` (extend `KNOWN_DATA_ROUTES`)
- create `packages/merchant-backend/test/learned-routes.test.ts`

**Interfaces**
- Consumes: `LearnedStore`, `InMemoryLearnedStore`, `LearnedInsightNotFoundError`, `LearnedCategory`,
  `gradeInsight`, `isSafetyFloorViolation`, `TeachingStance`, `LearnedInsight` (`@palup/platform-ports`);
  `PostgresLearnedStore` (`@palup/state-postgres`); `requirePermission` (`@palup/identity-shopify`).
- Produces: `registerLearnedRoutes(app, { learnedStore })`; `interface LearnedRoutesDeps { learnedStore: LearnedStore }`;
  response DTO `interface SafeLearnedInsight { id; category; tier; origin; text; source; sampleSize; confidence; pinned; createdAt; updatedAt }`.

**Step 1 — write the failing test** `packages/merchant-backend/test/learned-routes.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore, InMemoryLearnedStore, type MerchantIdentityPort, type MerchantPrincipal } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";

function identityFor(p: MerchantPrincipal): MerchantIdentityPort {
  return { authenticate: async (c) => (c === "good" ? p : { kind: "anonymous" }), authorize: () => true };
}
const manager: MerchantPrincipal = { kind: "merchant_user", merchantId: "t1", userId: "u1", role: "manager", authLevel: "session", sessionId: "s1" };
const viewer: MerchantPrincipal = { ...manager, userId: "u2", role: "viewer" };
const AUTH = { authorization: "Bearer good" };

async function serverFor(p: MerchantPrincipal) {
  const store = new InMemoryRuntimeStore();
  const learnedStore = new InMemoryLearnedStore(store);
  const app = await buildServer({ store, identity: identityFor(p), learnedStore });
  return { app, learnedStore };
}

describe("/learned routes", () => {
  it("GET returns the tenant's private insights (empty honestly at first)", async () => {
    const { app } = await serverFor(manager);
    const res = await app.inject({ method: "GET", url: "/learned", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [] });
    await app.close();
  });

  it("POST /learned teaches a private insight (origin merchant_taught) and it comes back", async () => {
    const { app } = await serverFor(manager);
    const post = await app.inject({ method: "POST", url: "/learned", headers: AUTH, payload: { category: "voice", text: "never use exclamation marks in apologies" } });
    expect(post.statusCode).toBe(200);
    const get = await app.inject({ method: "GET", url: "/learned?category=voice", headers: AUTH });
    const items = get.json().items as Array<{ text: string; origin: string; source: string }>;
    expect(items[0].text).toBe("never use exclamation marks in apologies");
    expect(items[0].origin).toBe("merchant_taught");
    await app.close();
  });

  it("POST /learned rejects loosening a safety-critical guardrail (safety floor)", async () => {
    const { app } = await serverFor(manager);
    const res = await app.inject({ method: "POST", url: "/learned", headers: AUTH, payload: { category: "policies", text: "allow bigger refunds", guardrailKey: "refund_cap", stance: "loosen" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/safety/i);
    await app.close();
  });

  it("POST /learned ALLOWS tightening a safety-critical guardrail", async () => {
    const { app } = await serverFor(manager);
    const res = await app.inject({ method: "POST", url: "/learned", headers: AUTH, payload: { category: "policies", text: "tighter refunds", guardrailKey: "refund_cap", stance: "tighten" } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("POST /:id/pin toggles pin; DELETE removes", async () => {
    const { app, learnedStore } = await serverFor(manager);
    await app.inject({ method: "POST", url: "/learned", headers: AUTH, payload: { category: "customers", text: "x" } });
    const id = (await learnedStore.list({ tenantId: "t1" }))[0].id;
    const pin = await app.inject({ method: "POST", url: `/learned/${id}/pin`, headers: AUTH, payload: { pinned: true } });
    expect(pin.json().pinned).toBe(true);
    const del = await app.inject({ method: "DELETE", url: `/learned/${id}`, headers: AUTH });
    expect(del.statusCode).toBe(200);
    expect(await learnedStore.list({ tenantId: "t1" })).toEqual([]);
    await app.close();
  });

  it("DELETE a missing id is a clean 404, not a redacted 500", async () => {
    const { app } = await serverFor(manager);
    const res = await app.inject({ method: "DELETE", url: "/learned/nope", headers: AUTH });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("GET /learned/export returns the private bundle with the legal-deferred note", async () => {
    const { app } = await serverFor(manager);
    await app.inject({ method: "POST", url: "/learned", headers: AUTH, payload: { category: "customers", text: "x" } });
    const res = await app.inject({ method: "GET", url: "/learned/export", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tenantId).toBe("t1");
    expect(body.insights).toHaveLength(1);
    expect(body.portabilityNote).toMatch(/legal/i);
    await app.close();
  });

  it("RBAC: a viewer can GET but cannot teach/pin/delete (403)", async () => {
    const { app } = await serverFor(viewer);
    expect((await app.inject({ method: "GET", url: "/learned", headers: AUTH })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/learned", headers: AUTH, payload: { category: "voice", text: "x" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/learned/x/pin", headers: AUTH, payload: { pinned: true } })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: "/learned/x", headers: AUTH })).statusCode).toBe(403);
    await app.close();
  });
});
```
Also extend `route-protection.test.ts` `KNOWN_DATA_ROUTES` (this addition is itself the guard the test enforces):
```ts
{ method: "GET", url: "/learned" },
{ method: "POST", url: "/learned" },
{ method: "POST", url: "/learned/l1/pin" },
{ method: "DELETE", url: "/learned/l1" },
{ method: "GET", url: "/learned/export" },
```

**Step 2 — run, expect fail** (route + `learnedStore` opt missing) → red.

**Step 3 — minimal impl.** `packages/merchant-backend/src/routes/learned.ts`:
```ts
import type { FastifyInstance } from "fastify";
import { requirePermission } from "@palup/identity-shopify";
import {
  LearnedInsightNotFoundError, gradeInsight, isSafetyFloorViolation,
  type LearnedCategory, type LearnedInsight, type LearnedStore, type TeachingStance,
} from "@palup/platform-ports";
import { randomUUID } from "node:crypto";

// W3 Task 4: the merchant-facing Learned surface. Every route derives ctx from `req.principal.merchantId`
// ONLY (never a body/query/header) — same tenant-isolation guarantee as /rules and /audit. GET is
// `console.view` (every role reads their own brain); teach/pin/delete are `learned.edit` (manager+). The
// aggregate tier is NEVER served here — GET only ever returns the private layer (the hard wall is in the
// store; this route never even asks for `tier:"aggregate"`).

export interface LearnedRoutesDeps { learnedStore: LearnedStore }

/** Merchant-safe DTO (audit.ts discipline): a fixed field set, never the raw stored object, so a future
 *  field added to `LearnedInsight` can't leak through an accidental pass-through. */
export interface SafeLearnedInsight {
  id: string; category: LearnedCategory; tier: LearnedInsight["tier"]; origin: LearnedInsight["origin"];
  text: string; source: string; sampleSize: number; confidence: LearnedInsight["grounding"]["confidence"];
  pinned: boolean; createdAt: string; updatedAt: string;
}
function toSafe(i: LearnedInsight): SafeLearnedInsight {
  return { id: i.id, category: i.category, tier: i.tier, origin: i.origin, text: i.text,
    source: i.grounding.source, sampleSize: i.grounding.sampleSize, confidence: i.grounding.confidence,
    pinned: i.pinned, createdAt: i.createdAt, updatedAt: i.updatedAt };
}

const VALID_CATEGORIES: ReadonlySet<string> = new Set<LearnedCategory>(["customers", "products", "voice", "policies"]);

interface TeachBody { category?: unknown; text?: unknown; guardrailKey?: unknown; stance?: unknown }
interface PinBody { pinned?: unknown }

export function registerLearnedRoutes(app: FastifyInstance, deps: LearnedRoutesDeps): void {
  app.get<{ Querystring: { category?: string } }>("/learned", { preHandler: requirePermission("console.view") }, async (req) => {
    const ctx = { tenantId: req.principal!.merchantId };
    const category = req.query.category;
    const filter = category && VALID_CATEGORIES.has(category) ? { category: category as LearnedCategory } : undefined;
    const items = await deps.learnedStore.list(ctx, filter);
    return { items: items.map(toSafe) };
  });

  app.post<{ Body: TeachBody }>("/learned", { preHandler: requirePermission("learned.edit") }, async (req, reply) => {
    const ctx = { tenantId: req.principal!.merchantId };
    const { category, text, guardrailKey, stance } = req.body ?? {};
    if (typeof category !== "string" || !VALID_CATEGORIES.has(category)) return reply.code(400).send({ error: "invalid category" });
    if (typeof text !== "string" || !text.trim()) return reply.code(400).send({ error: "text is required" });
    // Safety floor (spec §10): a policy teaching may TIGHTEN a safety-critical guardrail but never loosen it.
    if (category === "policies" && typeof guardrailKey === "string" && (stance === "tighten" || stance === "loosen")) {
      if (isSafetyFloorViolation(guardrailKey, stance as TeachingStance)) {
        return reply.code(400).send({ error: "safety floor: a safety-critical guardrail can be tightened but not loosened" });
      }
    }
    const at = new Date().toISOString();
    // Merchant teaching is AUTHORITATIVE per-tenant config (not a statistical insight) — confidence "high",
    // sampleSize 0 by convention (it did not come from an observation count). It is NOT graded by
    // `gradeInsight` (that gate is for SYNTHESIZED insights, Task 5).
    const insight: LearnedInsight = {
      id: randomUUID(), tenantId: ctx.tenantId, category: category as LearnedCategory, tier: "private",
      origin: "merchant_taught", text: text.trim(),
      grounding: { source: "merchant_taught", sampleSize: 0, confidence: "high" },
      pinned: false, createdAt: at, updatedAt: at,
    };
    await deps.learnedStore.record(ctx, insight, req.principal!.userId);
    return { insight: toSafe(insight) };
  });

  app.post<{ Params: { id: string }; Body: PinBody }>("/learned/:id/pin", { preHandler: requirePermission("learned.edit") }, async (req, reply) => {
    const ctx = { tenantId: req.principal!.merchantId };
    const pinned = req.body?.pinned;
    if (typeof pinned !== "boolean") return reply.code(400).send({ error: "pinned (boolean) is required" });
    try {
      const next = await deps.learnedStore.setPinned(ctx, req.params.id, pinned, req.principal!.userId, new Date().toISOString());
      return toSafe(next);
    } catch (e) {
      if (e instanceof LearnedInsightNotFoundError) return reply.code(404).send({ error: "not found" });
      throw e;
    }
  });

  app.delete<{ Params: { id: string } }>("/learned/:id", { preHandler: requirePermission("learned.edit") }, async (req, reply) => {
    const ctx = { tenantId: req.principal!.merchantId };
    try {
      await deps.learnedStore.remove(ctx, req.params.id, req.principal!.userId, new Date().toISOString());
      return { removed: true };
    } catch (e) {
      if (e instanceof LearnedInsightNotFoundError) return reply.code(404).send({ error: "not found" });
      throw e;
    }
  });

  // Export the merchant's own private brain ("you own your agent's brain"). The READ mechanism is real; the
  // portability/format GUARANTEE + delivery is legal-deferred (spec §10), stated honestly in the payload.
  app.get("/learned/export", { preHandler: requirePermission("console.view") }, async (req) => {
    const ctx = { tenantId: req.principal!.merchantId };
    const insights = (await deps.learnedStore.list(ctx)).map(toSafe);
    return {
      tenantId: ctx.tenantId, exportedAt: new Date().toISOString(), insights,
      portabilityNote: "You own your agent's private brain. A signed, portable export format is pending legal review; this is the raw private layer as currently stored.",
    };
  });
}
```
Wire in `server.ts`: add `learnedStore?: LearnedStore` to `buildServer` opts; in the composition root add
the durable-vs-in-memory branch (mirroring `rulesStore`):
```ts
// imports
import { registerLearnedRoutes } from "./routes/learned.js";
import { PostgresLearnedStore } from "@palup/state-postgres"; // add to the existing state-postgres import
import { InMemoryLearnedStore, type LearnedStore } from "@palup/platform-ports"; // add to the existing platform-ports import
// in buildServer, after rulesStore:
let learnedStore: LearnedStore;
if (opts?.learnedStore) {
  learnedStore = opts.learnedStore;
} else if (runtimeResult?.sql) {
  const pg = new PostgresLearnedStore(runtimeResult.sql, store);
  await pg.migrate();
  learnedStore = pg;
} else {
  learnedStore = new InMemoryLearnedStore(store);
}
// inside the merchantPlane register callback:
registerLearnedRoutes(merchantPlane, { learnedStore });
```

**Step 2b — run route-protection** (`pnpm --filter @palup/merchant-backend exec vitest run test/route-protection.test.ts`): the five new routes must 401 with no token (they inherit `requireMerchant`).

**Step 4 — run, expect pass:** `pnpm --filter @palup/merchant-backend exec vitest run test/learned-routes.test.ts test/route-protection.test.ts` → green.

**Step 5 — commit:** `feat(merchant-backend): GET/POST/pin/DELETE/export /learned (RBAC-gated, audited, W3)`.

---

## Task 5 — Insight synthesizer producer + staging trigger (conservative grounding, dark)

The governed insight synthesizer: a pure function that turns raw observation signals into candidates, runs
each through `gradeInsight`, and records ONLY the grounded ones (dropping the rest, honestly) as private
`synthesized` insights. A staging trigger route exercises it end-to-end. Its prod promotion + eval-gate
wiring (evolution pipeline) is a **deferred human gate** (§6.3) — on staging it runs like any agent.

**Files**
- create `packages/agent-runtime/src/insight-synthesizer.ts`
- modify `packages/agent-runtime/src/index.ts` (export)
- create `packages/agent-runtime/test/insight-synthesizer.test.ts`
- create `packages/merchant-backend/src/routes/internal-insights.ts`
- modify `packages/merchant-backend/src/server.ts` (register the trigger)
- modify `packages/merchant-backend/test/route-protection.test.ts` (add `{ POST, /_internal/run-insights }`)
- create `packages/merchant-backend/test/internal-insights.test.ts`

**Interfaces**
- Consumes: `InsightCandidate`, `gradeInsight`, `LearnedInsight`, `LearnedStore`, `classifyFact`
  (`@palup/widget-memory`, for special-category flagging), `RuntimeStateCtx`.
- Produces:
  ```ts
  export interface SynthesisInput { candidates: InsightCandidate[]; now: string; newId: () => string; tenantId: string; }
  export interface SynthesisResult { recorded: LearnedInsight[]; dropped: Array<{ candidate: InsightCandidate; reason: string }>; }
  export function synthesizeInsights(input: SynthesisInput): SynthesisResult;
  export const INSIGHT_SYNTHESIZER_AGENT_ID = "insight_synthesizer";
  ```

**Step 1 — write the failing test** `packages/agent-runtime/test/insight-synthesizer.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { synthesizeInsights, INSIGHT_SYNTHESIZER_AGENT_ID } from "../src/insight-synthesizer.js";
import type { InsightCandidate } from "@palup/platform-ports";

let n = 0;
const newId = () => `id-${++n}`;
const base = { now: "2026-08-24T00:00:00Z", newId, tenantId: "t1" };

describe("synthesizeInsights (conservative grounding)", () => {
  it("records grounded candidates as private synthesized insights and drops sub-floor ones", () => {
    n = 0;
    const candidates: InsightCandidate[] = [
      { category: "customers", text: "First-time buyers convert with a sample add-on", source: "orders", sampleSize: 250 }, // high
      { category: "products", text: "Recovery set has the lowest return rate", source: "returns", sampleSize: 50 },           // medium
      { category: "customers", text: "thin signal", source: "orders", sampleSize: 3 },                                        // dropped
      { category: "voice", text: "  ", source: "chat", sampleSize: 999 },                                                     // dropped (empty)
    ];
    const r = synthesizeInsights({ ...base, candidates });
    expect(r.recorded.map((i) => i.grounding.confidence)).toEqual(["high", "medium"]);
    expect(r.recorded.every((i) => i.origin === "synthesized" && i.tier === "private" && i.tenantId === "t1")).toBe(true);
    expect(r.dropped).toHaveLength(2);
    expect(r.dropped[0].reason).toMatch(/below floor/);
  });
});

describe("agent identity", () => {
  it("is a stable slug", () => { expect(INSIGHT_SYNTHESIZER_AGENT_ID).toBe("insight_synthesizer"); });
});
```

**Step 2 — run, expect fail** → red.

**Step 3 — minimal impl** `packages/agent-runtime/src/insight-synthesizer.ts`:
```ts
import { gradeInsight, type InsightCandidate, type LearnedInsight } from "@palup/platform-ports";

/** The insight synthesizer agent's stable id — the `actor` on every insight it records + audits. */
export const INSIGHT_SYNTHESIZER_AGENT_ID = "insight_synthesizer";

export interface SynthesisInput { candidates: InsightCandidate[]; now: string; newId: () => string; tenantId: string; }
export interface SynthesisResult { recorded: LearnedInsight[]; dropped: Array<{ candidate: InsightCandidate; reason: string }>; }

/** Pure: run every candidate through the conservative grounding gate. Only `surface:true` candidates
 *  become private `synthesized` insights (confidence from the gate). Everything else is dropped WITH a
 *  reason — the caller may audit the drop, but nothing sub-floor is ever surfaced (spec §10: a wrong
 *  insight acted on burns trust). No `Date.now()`/id generation in here — both are injected. */
export function synthesizeInsights(input: SynthesisInput): SynthesisResult {
  const recorded: LearnedInsight[] = [];
  const dropped: SynthesisResult["dropped"] = [];
  for (const candidate of input.candidates) {
    const verdict = gradeInsight(candidate);
    if (!verdict.surface) { dropped.push({ candidate, reason: verdict.reason }); continue; }
    recorded.push({
      id: input.newId(), tenantId: input.tenantId, category: candidate.category, tier: "private",
      origin: "synthesized", text: candidate.text.trim(),
      grounding: { source: candidate.source, sampleSize: candidate.sampleSize, confidence: verdict.confidence },
      pinned: false, createdAt: input.now, updatedAt: input.now,
    });
  }
  return { recorded, dropped };
}
```
Export from `agent-runtime/src/index.ts`. Trigger route `packages/merchant-backend/src/routes/internal-insights.ts`:
```ts
import type { FastifyInstance } from "fastify";
import { requirePermission } from "@palup/identity-shopify";
import type { InsightCandidate, LearnedStore } from "@palup/platform-ports";
import { classifyFact } from "@palup/widget-memory";
import { synthesizeInsights, INSIGHT_SYNTHESIZER_AGENT_ID } from "@palup/agent-runtime";
import { randomUUID } from "node:crypto";

// W3 Task 5: `POST /_internal/run-insights` — a STAGING TRIGGER for the insight synthesizer, so staging
// can exercise gather→grade→record end-to-end for the caller's own tenant. // staging trigger; replaced
// by the scheduled runtime host (later plan). ctx from `req.principal.merchantId` ONLY. Records only
// grounded insights; drops the rest honestly. A candidate whose text classifies special-category
// (`classifyFact`) is FLAGGED in the audit; surfacing it in prod stays memory-legal-gated (ADR-0015).
//
// Candidate SOURCE: for this staging trigger the candidates arrive in the request body (a real scheduled
// host will gather them from orders/chats/outcomes). An empty/sub-floor gather records NOTHING — the
// console then shows an honest "still measuring" empty state, never a fabricated insight.

export interface RunInsightsDeps { learnedStore: LearnedStore }

interface RunInsightsBody { candidates?: InsightCandidate[] }

export function registerInternalInsightsRoutes(app: FastifyInstance, deps: RunInsightsDeps): void {
  app.post<{ Body: RunInsightsBody }>("/_internal/run-insights", { preHandler: requirePermission("agent.operate") }, async (req) => {
    const ctx = { tenantId: req.principal!.merchantId };
    const candidates = Array.isArray(req.body?.candidates) ? req.body!.candidates : [];
    const now = new Date().toISOString();
    const { recorded, dropped } = synthesizeInsights({ candidates, now, newId: randomUUID, tenantId: ctx.tenantId });
    const flaggedSpecial: string[] = [];
    for (const insight of recorded) {
      if (classifyFact(insight.text).class === "special") flaggedSpecial.push(insight.id); // memory-legal-gated for prod
      await deps.learnedStore.record(ctx, insight, INSIGHT_SYNTHESIZER_AGENT_ID);
    }
    return { recorded: recorded.length, dropped: dropped.length, flaggedSpecial };
  });
}
```
Wire in `server.ts` (`registerInternalInsightsRoutes(merchantPlane, { learnedStore })`) and add
`{ method: "POST", url: "/_internal/run-insights" }` to `KNOWN_DATA_ROUTES`.

`packages/merchant-backend/test/internal-insights.test.ts` asserts: a grounded candidate lands one
private insight (GET /learned shows it); a sub-floor candidate records nothing (GET stays empty); a
`viewer` gets 403; a special-category text (e.g. "customers with a nut allergy prefer …") is reported in
`flaggedSpecial`.

**Step 4 — run, expect pass** (`pnpm --filter @palup/agent-runtime exec vitest run test/insight-synthesizer.test.ts` and the merchant-backend suites) → green.
**Step 5 — commit:** `feat(agent-runtime,merchant-backend): insight synthesizer + staging trigger (W3, dark)`.

---

## Task 6 — Agent-proposes / merchant-owns Voice (W1 proposal, never a silent write)

The voice mechanism: a merchant edits voice directly (Task 4's teach with `category:"voice"` — their own
config). The **agent** proposing a voice change must route through the **W1 proposal loop** — it never
silently alters voice. Reuse `proposeOrExecute` (category `autonomy_scope`, which is never auto-eligible →
always a pending proposal). On approval + execution, the executor writes the new voice insight to the
LearnedStore.

**Files**
- create `packages/agent-runtime/src/voice.ts`
- modify `packages/agent-runtime/src/index.ts` (export)
- create `packages/agent-runtime/test/voice.test.ts`
- create `packages/merchant-backend/src/routes/internal-voice.ts`
- modify `packages/merchant-backend/src/server.ts` (register)
- modify `packages/merchant-backend/test/route-protection.test.ts` (add `{ POST, /_internal/propose-voice }`)
- create `packages/merchant-backend/test/internal-voice.test.ts`

**Interfaces**
- Consumes: `proposeOrExecute`, `EngineDeps`, `Executor`, `ExecutorInput`, `ExecutionResult` (`@palup/agent-runtime`);
  `AgentAction`, `ReversalPlan`, `ProposeOrExecuteResult`, `LearnedStore`, `LearnedInsight` (ports).
- Produces:
  ```ts
  export interface ProposeVoiceChangeInput { ctx: RuntimeStateCtx; now: string; proposedVoiceText: string; rationale: string; agentId?: string; }
  export function proposeVoiceChange(input: ProposeVoiceChangeInput, deps: EngineDeps): Promise<ProposeOrExecuteResult>;
  export function voiceChangeExecutor(learnedStore: LearnedStore, newId: () => string, now: () => string): Executor;
  export const VOICE_AGENT_TYPE = "insight_synthesizer";
  ```

**Step 1 — write the failing test** `packages/agent-runtime/test/voice.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore, InMemoryProposalStore, InMemoryLearnedStore } from "@palup/platform-ports";
import { proposeVoiceChange, voiceChangeExecutor } from "../src/voice.js";
import { createRulesProvider } from "../src/rules.js";
import { InMemoryMerchantRulesStore } from "@palup/platform-ports";

function deps(store: InMemoryRuntimeStore, learnedStore: InMemoryLearnedStore) {
  return {
    store: new InMemoryProposalStore(store),
    state: store,
    rules: createRulesProvider(new InMemoryMerchantRulesStore(store)),
    executor: voiceChangeExecutor(learnedStore, () => "v1", () => "2026-08-24T00:00:00Z"),
    validate: async () => ({ valid: true }),
  };
}

describe("proposeVoiceChange", () => {
  it("NEVER auto-executes — a voice change is always a pending proposal (autonomy_scope)", async () => {
    const store = new InMemoryRuntimeStore();
    const learnedStore = new InMemoryLearnedStore(store);
    const r = await proposeVoiceChange(
      { ctx: { tenantId: "t1" }, now: "2026-08-24T00:00:00Z", proposedVoiceText: "Warmer, no exclamation marks", rationale: "chat signals" },
      deps(store, learnedStore),
    );
    expect(r.kind).toBe("proposed");
    expect(r.proposal?.category).toBe("autonomy_scope");
    expect(r.proposal?.status).toBe("pending");
    expect(r.proposal?.reversalPlan.reversible).toBe(true);
    // No voice insight was written — the merchant hasn't approved (voice is merchant-owned).
    expect(await learnedStore.list({ tenantId: "t1" }, { category: "voice" })).toEqual([]);
  });
});

describe("voiceChangeExecutor", () => {
  it("writes the approved voice text as a private voice insight when the loop executes it", async () => {
    const store = new InMemoryRuntimeStore();
    const learnedStore = new InMemoryLearnedStore(store);
    const exec = voiceChangeExecutor(learnedStore, () => "v1", () => "2026-08-24T00:00:00Z");
    const res = await exec({ ctx: { tenantId: "t1" }, agentId: "insight_synthesizer", agentType: "insight_synthesizer", action: { type: "change_voice", params: { proposedVoiceText: "Warmer" } }, executionId: "e1" });
    expect(res.ok).toBe(true);
    const voice = await learnedStore.list({ tenantId: "t1" }, { category: "voice" });
    expect(voice[0].text).toBe("Warmer");
    expect(voice[0].origin).toBe("synthesized");
  });
});
```

**Step 2 — run, expect fail** → red.

**Step 3 — minimal impl** `packages/agent-runtime/src/voice.ts`:
```ts
import type { AgentAction, LearnedInsight, LearnedStore, ReversalPlan, RuntimeStateCtx } from "@palup/platform-ports";
import { proposeOrExecute, type EngineDeps, type Executor, type ProposeOrExecuteResult } from "./loop.js";

/** Voice changes are proposed by the insight synthesizer agent — the same agent type the LearnedStore's
 *  voice insights are attributed to. */
export const VOICE_AGENT_TYPE = "insight_synthesizer";

export interface ProposeVoiceChangeInput { ctx: RuntimeStateCtx; now: string; proposedVoiceText: string; rationale: string; agentId?: string; }

/**
 * The agent PROPOSING a voice change — never a silent write (spec §10: "merchant owns voice — the agent
 * may propose voice changes but never silently alters how it talks"). Routed through the W1 spine
 * (`proposeOrExecute`) as `autonomy_scope`, which is NEVER auto-eligible (`AUTO_ELIGIBLE_DIMENSIONS
 * .autonomy_scope = []`, `PALUP_FLOORS.autonomy_scope.maxAutoPct = 0`) — so it always becomes a pending
 * proposal the merchant must approve. `assertNotKilled` (inside `proposeOrExecute`) still gates it.
 */
export async function proposeVoiceChange(input: ProposeVoiceChangeInput, deps: EngineDeps): Promise<ProposeOrExecuteResult> {
  const action: AgentAction = { type: "change_voice", params: { proposedVoiceText: input.proposedVoiceText }, irreversible: false };
  const reversalPlan: ReversalPlan = {
    reversible: true,
    plan: "Reversible: the prior voice guidance stays in the Learned store; delete the new voice insight (DELETE /learned/:id) or re-teach the prior wording to revert. Nothing is sent to shoppers by approving a voice change.",
  };
  const result = await proposeOrExecute(
    { ctx: input.ctx, agentId: input.agentId ?? VOICE_AGENT_TYPE, agentType: VOICE_AGENT_TYPE, category: "autonomy_scope",
      rationale: input.rationale, reversalPlan, now: input.now, action,
      estimatedImpact: { note: "Changes how the agent talks; no direct spend or send." } },
    deps,
  );
  // Defensive (§3): a voice/behavior change must NEVER auto-apply. If the loop ever executes one, that is
  // a governance breach, not a result to return silently.
  if (result.kind === "executed") {
    throw new Error("proposeVoiceChange: a voice change was auto-executed — this must never happen (CLAUDE.md §3); voice is merchant-owned and requires approval");
  }
  return result;
}

/** The executor the W1 loop runs on APPROVAL: it writes the approved voice text as a private voice
 *  insight. Attributed to the synthesizer (origin "synthesized"); confidence "high" because a human
 *  approved it. `newId`/`now` injected (no `Date.now()`/uuid in this module). */
export function voiceChangeExecutor(learnedStore: LearnedStore, newId: () => string, now: () => string): Executor {
  return async ({ ctx, agentId, action }) => {
    const text = String(action.params.proposedVoiceText ?? "").trim();
    if (!text) return { ok: false, detail: "empty voice text — nothing to apply" };
    const at = now();
    const insight: LearnedInsight = {
      id: newId(), tenantId: ctx.tenantId, category: "voice", tier: "private", origin: "synthesized",
      text, grounding: { source: "approved_voice_change", sampleSize: 0, confidence: "high" },
      pinned: false, createdAt: at, updatedAt: at,
    };
    await learnedStore.record(ctx, insight, agentId);
    return { ok: true, detail: `voice insight ${insight.id} recorded` };
  };
}
```
Export from `agent-runtime/src/index.ts`. Trigger route `internal-voice.ts` (`POST /_internal/propose-voice`,
`requirePermission("agent.operate")`) wires `proposeVoiceChange` with `EngineDeps` built from the injected
stores (proposalStore, state, `createRulesProvider(rulesStore)`, `voiceChangeExecutor(learnedStore, randomUUID, () => new Date().toISOString())`, `validate: async () => ({ valid: true })`), returns
`{ proposedId }`. Register in `server.ts`; add `{ POST, /_internal/propose-voice }` to `KNOWN_DATA_ROUTES`.
`internal-voice.test.ts` asserts a pending `autonomy_scope` proposal is created and appears in
`GET /approvals?category=autonomy_scope`, and that no voice insight exists until approval.

**Step 4 — run, expect pass** → green.
**Step 5 — commit:** `feat(agent-runtime,merchant-backend): agent-proposes voice change via W1, merchant-owns (W3)`.

---

## Task 7 — Console API client: learned methods + types

Add the typed client methods the Learned screen needs, mirroring the backend wire contract exactly
(`routes/learned.ts`'s `SafeLearnedInsight` + response envelopes), reusing `request<T>` + `toQuery`.

**Files**
- modify `packages/merchant-console/src/app/api.ts`
- modify `packages/merchant-console/src/app/api.test.ts`

**Interfaces**
- Produces (added to `ApiClient` + implemented in the returned object):
  ```ts
  export type LearnedCategory = "customers" | "products" | "voice" | "policies";
  export interface LearnedInsight {
    id: string; category: LearnedCategory; tier: "private" | "aggregate"; origin: "synthesized" | "merchant_taught";
    text: string; source: string; sampleSize: number; confidence: "medium" | "high"; pinned: boolean; createdAt: string; updatedAt: string;
  }
  export interface TeachRequest { category: LearnedCategory; text: string; guardrailKey?: string; stance?: "tighten" | "loosen"; }
  // on ApiClient:
  listLearned(q: { category?: LearnedCategory }): Promise<{ items: LearnedInsight[] }>;
  teachLearned(req: TeachRequest): Promise<{ insight: LearnedInsight }>;
  pinLearned(id: string, pinned: boolean): Promise<LearnedInsight>;
  deleteLearned(id: string): Promise<{ removed: boolean }>;
  ```

**Step 1 — write the failing test** — extend `api.test.ts` with a `fetch` fake asserting: `listLearned`
GETs `/api/learned?category=voice` with the bearer header; `teachLearned` POSTs the JSON body;
`pinLearned` POSTs `/api/learned/<id>/pin`; `deleteLearned` DELETEs; a 403 maps to `ApiError` with
`status: 403`. (Follow the existing `api.test.ts` fake-fetch shape — a `vi.fn` returning `{ ok, status,
json }`, asserting the URL/method/headers passed.)

**Step 2 — run, expect fail** → red.

**Step 3 — minimal impl** — add the types to `api.ts`, the four signatures to the `ApiClient` interface,
and the implementations to the returned object:
```ts
async listLearned(q) {
  return request<{ items: LearnedInsight[] }>(`/learned${toQuery({ category: q.category })}`);
},
async teachLearned(req) {
  return request<{ insight: LearnedInsight }>(`/learned`, { method: "POST", body: JSON.stringify(req) });
},
async pinLearned(id, pinned) {
  return request<LearnedInsight>(`/learned/${encodeURIComponent(id)}/pin`, { method: "POST", body: JSON.stringify({ pinned }) });
},
async deleteLearned(id) {
  return request<{ removed: boolean }>(`/learned/${encodeURIComponent(id)}`, { method: "DELETE" });
},
```

**Step 4 — run, expect pass** → green.
**Step 5 — commit:** `feat(merchant-console): learned API client methods (W3)`.

---

## Task 8 — Console Learned screen (`src/screens/learned/`) + wire the route

The screen: tabs (All / Customers / Products / Voice / Policies), a table (Insight / Source / Confidence /
Learned), a "Teach your agent" panel (category + text; optional guardrail + stance for policies), pin +
delete actions, and honest empty / "still measuring" states. It matches `palup-merchant-app.html`
`#learned`'s layout, labels, and copy but renders ONLY real API data — no fabricated counts, no 96%
voice-match tile. It also shows an honest "Network insights (aggregate): coming soon — pending
legal/security review" note (the aggregate layer is OFF; the console never invents priors).

**Files**
- create `packages/merchant-console/src/screens/learned/LearnedView.tsx`
- create `packages/merchant-console/src/screens/learned/TeachPanel.tsx`
- create `packages/merchant-console/src/screens/learned/LearnedView.test.tsx`
- create `packages/merchant-console/src/screens/learned/TeachPanel.test.tsx`
- modify `packages/merchant-console/src/App.tsx` (remove `/learned` from `STUB_ROUTES`, add the real route + import)

**Interfaces**
- Consumes: `Pick<ApiClient, "listLearned" | "teachLearned" | "pinLearned" | "deleteLearned">`, `LearnedInsight`,
  `LearnedCategory` (from `app/api`); design-system `Tabs/TabsList/TabsTrigger/TabsContent`, `Table`
  family, `Badge`, `Button`, `Note`, `Field`, `Input`, `Textarea`, `Select`, `useToast`.
- Produces: `export function LearnedView({ api }: { api: ApiClient })`; `export function TeachPanel({ api, onTaught }: {...})`.

**Step 1 — write the failing tests.** `LearnedView.test.tsx` (fake `ApiClient` with `vi.fn` methods):
```ts
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ApiClient, LearnedInsight } from "../../app/api";
import { LearnedView } from "./LearnedView";

function fact(over: Partial<LearnedInsight> = {}): LearnedInsight {
  return { id: "l1", category: "customers", tier: "private", origin: "synthesized",
    text: "First-time buyers convert with a sample add-on", source: "orders", sampleSize: 250, confidence: "high",
    pinned: false, createdAt: "2026-08-24T00:00:00Z", updatedAt: "2026-08-24T00:00:00Z", ...over };
}
function fakeApi(items: LearnedInsight[]): ApiClient {
  return {
    listLearned: vi.fn(async () => ({ items })),
    teachLearned: vi.fn(async (r) => ({ insight: fact({ id: "new", ...r }) })),
    pinLearned: vi.fn(async (id, pinned) => fact({ id, pinned })),
    deleteLearned: vi.fn(async () => ({ removed: true })),
  } as unknown as ApiClient;
}

describe("LearnedView", () => {
  it("renders each insight's text, source, and confidence badge — no fabricated numbers", async () => {
    render(<LearnedView api={fakeApi([fact()])} />);
    expect(await screen.findByText(/first-time buyers convert/i)).toBeInTheDocument();
    expect(screen.getByText("orders")).toBeInTheDocument();
    expect(screen.getByText(/high/i)).toBeInTheDocument();
    expect(screen.queryByText("96%")).not.toBeInTheDocument(); // the mockup's fake voice-match tile is gone
  });
  it("shows an honest empty / still-measuring state when there is nothing yet", async () => {
    render(<LearnedView api={fakeApi([])} />);
    expect(await screen.findByText(/still measuring|nothing learned yet/i)).toBeInTheDocument();
  });
  it("shows the aggregate-network layer as coming-soon (OFF, pending legal/security)", async () => {
    render(<LearnedView api={fakeApi([fact()])} />);
    expect(await screen.findByText(/network insights.*coming soon|pending legal/i)).toBeInTheDocument();
  });
  it("pins an insight via the API", async () => {
    const api = fakeApi([fact({ id: "l1", pinned: false })]);
    render(<LearnedView api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: /pin/i }));
    expect(api.pinLearned).toHaveBeenCalledWith("l1", true);
  });
});
```
`TeachPanel.test.tsx` asserts: submitting category + text calls `teachLearned`; a policies teaching
surfaces the guardrail + stance inputs; an empty text disables submit.

**Step 2 — run, expect fail** → red.

**Step 3 — minimal impl.** `LearnedView.tsx` — load `listLearned` (re-fetch on tab change or filter
client-side), render the table with `Badge` confidence (`high`→`pos`, `medium`→`warn`, pinned→`ever`),
Pin/Unpin + Delete buttons wired to `pinLearned`/`deleteLearned` (+ `useToast`), the `TeachPanel`, honest
empty state, and a static `Note variant="info"` for the aggregate coming-soon line. Use ONLY design-system
primitives and tokens; match `#learned`'s column headers (Insight / Source / Confidence / Learned) and the
"Teach your agent" copy, but drive every value from the API and never render a hard-coded count. `App.tsx`:
```tsx
import { LearnedView } from "./screens/learned/LearnedView";
// remove { path: "/learned", title: "Agent Memory" } from STUB_ROUTES
// add inside <Routes>:
<Route path="/learned" element={<LearnedView api={api} />} />
```
(The nav link `link("/learned", "Agent Memory")` already exists in `app/shell.tsx` — no nav change.)

**Step 4 — run, expect pass** (`pnpm --filter @palup/merchant-console exec vitest run src/screens/learned`) → green.
**Step 5 — commit:** `feat(merchant-console): Agent Memory (Learned) screen — real data, honest states (W3)`.

---

## Full-suite gate (before the workstream PR)

Run the four CI-gate commands (not three): `pnpm build`, `pnpm test`, `pnpm e2e`, `pnpm e2e:monitor`
(per project memory "Full CI gate set"), plus `pnpm eval` is not required for this workstream (no run-time
agent quality-gate change ships enabled). Do NOT set `GOOGLE_CLOUD_PROJECT` for the gate (mock-path
memory). Merge via `merge-gate.sh` (local gate; no branch protection). Routine + flag-off PRs self-merge
after §4 reviews; anything touching authz/credentials/agent-autonomy gets `security-reviewer`.

## Deferred human/legal/enablement gates

- **Aggregate cross-merchant layer (the platform moat).** `AGGREGATE_LEARNING_ADR_ACCEPTED = false` and the
  layer has **zero live callers**. Enabling it requires the §13 legal/security review that defines
  "aggregate enough" (k-anonymity floor value, the anonymization/contributor-tag scheme, competitive
  fairness) + a named-human ADR + the secret for the contributor HMAC via the secrets port. A build agent
  must NEVER flip this or wire a `contribute` caller.
- **Insight synthesizer prod promotion.** The synthesizer runs on staging (per §6.3); its blocking
  eval-gate + evolution-pipeline promotion to production traffic is a human gate — not built here.
- **Special-category insights.** Insight text that classifies `special` (`classifyFact`, ADR-0015) is
  flagged; surfacing/persisting it in production stays memory-legal-gated (MEMORY-GO-LIVE-CHECKLIST;
  `isMemoryEnabled` stays off in prod). No flag flip here.
- **Export portability guarantee.** `GET /learned/export` returns the raw private layer now; the signed,
  portable, legally-reviewed export FORMAT + delivery is legal-deferred (spec §10) — stated honestly in
  the payload, not promised in code.
- **Postgres deploy / migrations.** `pl_learned_insight` migrates at boot on the durable path (like
  `pl_merchant_rules`); a real staging enable is an operator deploy step, not a build step.
- **Governance-touching edits** (HITL policy, evolution gate, operating manual) are explicitly out of
  scope for this plan; if the synthesizer's promotion path needs one, it is a named-human edit, flagged
  here, not authored in this workstream.

## Assumes from earlier blocks

- **F1 `@palup/design-system`** (built) — `Tabs`, `Table` family, `Badge`, `Button`, `Note`, `Field`,
  `Input`, `Textarea`, `Select`, `useToast`, tokens/preset. Task 8 consumes these; invents no primitive.
- **F2 `@palup/identity-shopify`** (built) — `requireMerchant`, `requirePermission`, `MerchantPrincipal`;
  the `learned.edit` permission already exists (manager+ in `DEFAULT_ROLE_PERMISSIONS`). Tasks 4–6 consume it.
- **F3 `@palup/merchant-backend`** (built) — `buildServer` composition root, the `merchantPlane`
  encapsulated auth context, the redacting error handler, the `registeredRoutes` structural guard,
  `createRuntimeStore()`'s durable-vs-in-memory `sql` branch. Tasks 4–6 extend these.
- **E1 `@palup/agent-runtime`** (built) — `proposeOrExecute` + `EngineDeps` + `Executor` +
  `createRulesProvider` (the W1 spine + classifier). Task 6 (voice proposal) and Task 5 (synthesizer)
  build on these; `autonomy_scope` being never-auto-eligible (`AUTO_ELIGIBLE_DIMENSIONS` /
  `PALUP_FLOORS`, W4-min) is what guarantees a voice change can't auto-apply.
- **W1 Approval Center** (built) — the voice-change proposal (Task 6) surfaces and is decided in W1's
  `GET /approvals` / approve / audit surfaces; this plan produces the proposal, W1 consumes it. Approval →
  execution (which runs `voiceChangeExecutor`) is W1's `executeApproved` path; Task 6 supplies the executor.
- **W4-min rules** (built) — `MerchantRulesStore` + `createRulesProvider` feed the classifier the
  synthesizer/voice producers run through. `SAFETY_CRITICAL_GUARDRAILS` (Task 1) references the real
  `PALUP_FLOORS` inviolable ceilings by name.
- **widget-memory** (built, staging-ON) — `classifyFact` + `FactClass` for special-category flagging
  (Task 5). W3 does NOT re-use widget-memory's per-shopper subject store for the merchant learned layer
  (different granularity: per-tenant insights vs per-anon-subject facts); it reuses only the classifier +
  consent semantics for the special-category path.
- **`@palup/state-postgres`** (built) — `Sql`, `PostgresRuntimeStore`, the testcontainer helpers, the
  `createRuntimeStore()` shared pool; Task 3 adds `PostgresLearnedStore` alongside `PostgresMerchantRulesStore`.
