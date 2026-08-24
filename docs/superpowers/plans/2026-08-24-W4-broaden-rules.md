# Broaden Automation Rules (W4 full envelope) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Run the `palup-design-system` skill before any console/Tailwind code and `hitl-approval-gate` before the classifier/executor tasks (3, 4, 7) — they touch the money boundary.

**Goal:** Grow W4-min's minimal `{allowedAuto, maxPct, maxUsd}` envelope into the **full standing money envelope** the spec's W4 describes: discount ceiling **+ stacking**, ad-spend **budget + ROI floor**, refund **+ price-match** limits, **subscription policy**, and comms **frequency + quiet hours** — as a real **three-layer** envelope (`PalUp inviolable floors < merchant envelope < agent auto-act limit`) whose new dimensions are **enforced LIVE in the classifier, not display-only**. Ship a **conservative-but-useful Day-1 preset** and **vertical default presets**, **big-jump confirmation** (server-side preview + console confirm) with **audited provenance**, an **agent-initiated rule change path that flows through W1**, and the **full rules-editor console screen**. INVIOLABLE PalUp floors (mass-send, spend-sanity, discount-depth, refund-abuse) remain values the merchant can never exceed.

**Architecture:** The rule domain already lives in `@palup/platform-ports` (`merchant-rules-store.ts`: types, `PALUP_FLOORS`, `CONSERVATIVE_DEFAULTS`, `InMemoryMerchantRulesStore`, `clampToFloor`, `isBigJump`, `mergeOverDefaults`); its Postgres twin is `@palup/state-postgres` (`PostgresMerchantRulesStore`); `@palup/agent-runtime` adapts it into the classifier's `RulesProvider` (`createRulesProvider`) and enforces it in `classifyAction`; `@palup/merchant-backend` exposes `GET/PUT /rules` inside the authenticated `merchantPlane`; `@palup/merchant-console` renders it. This plan **extends every one of those layers additively** — all new envelope fields are **optional** so existing rows/tests keep resolving, the classifier gets new **fail-closed** gates without weakening any existing invariant, and the console `/rules` stub is replaced by a real screen. No new package, no new store; the three-layer model already exists structurally (`clampToFloor(merchantEnvelope, PALUP_FLOORS[category])`) — we thicken the merchant layer and add one genuinely-new inviolable dimension (period spend-sanity).

**Tech Stack:** TypeScript (ESM), vitest, Fastify (routes), React + Vite + Tailwind + `@palup/design-system` (console). Depends on `@palup/platform-ports` (envelope/floor types, `RuntimeStatePort`, `Permission`), `@palup/agent-runtime` (`classifyAction`, `createRulesProvider`, `proposeOrExecute`/`Executor`), `@palup/state-postgres` (`PostgresMerchantRulesStore`), F2 (`requireMerchant`/`requirePermission`, `Permission "rules.edit"`/`"console.view"`), F3 (route mount + `req.principal`), W1 (Approval Center for the agent-proposed path). Test runner (no `GOOGLE_CLOUD_PROJECT` — routes backend integration tests to real Vertex and 5000ms-times-out): `PGVECTOR_TESTCONTAINER=off pnpm exec vitest run <path>`. Console build check: `pnpm --filter @palup/merchant-console build`.

**Spec:** `docs/superpowers/specs/2026-08-23-merchant-console-and-agent-runtime-design.md` — §9 **W4 · Automation Rules**, §10 Rules decisions ledger, §11 build order block 4 ("broaden W4"), §12 non-negotiables. Depends on plans **W4-min** (the envelope + `GET/PUT /rules` + `createRulesProvider` this broadens), **E1** (`classifyAction`/`proposeOrExecute` seam), **W1** (Approval Center, for the agent-proposed rule-change flow), **F2/F3** (auth + service). Informed by **W3** aggregate layer (presets' *numbers* may later be tuned from network data — but the presets themselves ship without it).

## Global Constraints

- **Money/model/business-model never auto-applies (CLAUDE.md §3.1).** This is the densest money-boundary config in the product. Every new gate is **fail-closed**: an absent/ambiguous merchant setting resolves to *requires approval*, never to auto. The classifier's four fail-closed invariants (`classify.ts` header) are **preserved unchanged** — new gates only ever *add* boundary reasons, never remove one or turn a `requires_approval` into `auto`.
- **PalUp floors are inviolable.** `PALUP_FLOORS` (code constants) bound every merchant/agent envelope. A merchant may only ever set their layer **tighter** than the floor; `clampToFloor` pulls any looser value down (fail-closed to `0`/`false` when the floor for a dimension is somehow absent). The four named floors — **mass-send** (`massSendRecipientFloor`, unconditional in `classifyAction`), **discount-depth** (`discount.maxAutoPct`), **refund-abuse** (`refund.maxAutoUsd`), **spend-sanity** (`ad_spend.maxAutoUsd` per-action **+ new `maxAutoPeriodUsd` per-period**) — cannot be exceeded from the console or by an agent.
- **Enforced live, not display-only.** Every new dimension is read by `classifyAction` at classify time from `action.params` (kept a **pure, deterministic** function — no `Date.now()`/`Math.random()`; windowed inputs like "sends this week" are passed in by the producing agent, not read from ambient state here).
- **Merchant sovereign, instant.** A `PUT /rules` / `apply-preset` takes effect immediately (the classifier reads live) with **no artificial cooldown**. A **big jump** is *previewable* (server computes before/after + a plain-language "this lets the agent … up to X") and the console **confirms** it, but the server never blocks or delays a sovereign merchant edit.
- **Every rule change audited with provenance.** `MerchantRulesStore.set` already writes a hash-chained `rules.changed` audit record carrying `provenance` (`merchant_set` | `agent_proposed`) and before/after; every new write path routes through it. No silent mutation.
- **Agent-initiated changes flow through W1.** An agent may **never** call `rulesStore.set` directly. A proposed envelope expansion is an `AgentAction` that classifies to `autonomy_scope` → `requires_approval` → an Approval-Center `Proposal`; only a human approval executes the `set` (provenance `agent_proposed`). Built dark: no agent emits one yet.
- **RBAC / tenant isolation.** Read routes `requirePermission("console.view")` (every role); write routes `requirePermission("rules.edit")` (manager+). `ctx.tenantId = req.principal!.merchantId` **always** — never from body/query/header. Every new data route lives inside `merchantPlane` and is added to `KNOWN_DATA_ROUTES` in `route-protection.test.ts`, never to `AUTH_EXEMPT_PATHS`.
- **Portability.** All state via `RuntimeStatePort`; no provider SDK in feature code (ADR-0001).
- **Build dark / staging-shaped.** Mechanisms real and tested; no §3 enablement flipped. The Day-1/vertical presets are *available* but applying one is an explicit merchant/onboarding action, never auto-applied. Governance-touching → **flag a deferred named human owner** (see the floor-edit note in Task 1 and the Deferred gates section); this plan never edits the HITL policy, the evolution gate, or the operating manual.
- Build-time dev against an APPROVED, owned spec; **security-reviewer required** on Tasks 1, 3, 4, 7 (money-boundary + agent-autonomy code); self-merge on gate-green per project policy.

## Interfaces (pin these — consistent across every task below)

```ts
// @palup/platform-ports — merchant-rules-store.ts (extended, all new fields OPTIONAL/backward-compatible)
export type SubscriptionSubAction = "pause" | "skip" | "cancel";
export interface QuietHours { startHour: number; endHour: number; } // 0–23, [start, end) in recipient local time; start>end wraps midnight

export interface CategoryRuleEnvelope {
  allowedAuto: boolean;
  maxPct?: number;                 // discount depth
  maxUsd?: number;                 // per-action dollar cap (refund/ad_spend/etc.)
  stackable?: boolean;             // discount: may auto-stack with other codes? absent ⇒ false (fail-closed)
  periodBudgetUsd?: number;        // ad_spend: rolling-period auto-spend ceiling
  roiFloor?: number;               // ad_spend: min projected ROI (revenue/spend) to auto-buy; absent ⇒ no ROI gate (opt-in)
  priceMatchMaxUsd?: number;       // refund: max auto price-match credit; absent ⇒ 0 (fail-closed)
  subscriptionSelfServe?: SubscriptionSubAction[]; // subscription: sub-actions the agent may auto-do; absent ⇒ [] (all escalate)
  frequencyCapPerWeek?: number;    // campaign/comms: max auto-sends to one recipient / rolling 7d; absent ⇒ no freq gate (opt-in)
  quietHours?: QuietHours;         // campaign/comms: window auto-sends are NOT allowed; absent ⇒ no quiet-hours gate (opt-in)
}
export interface AutoActLimit {    // the CLAMPED runtime shape the classifier reads (adds the same policy fields, post-clamp)
  allowedAuto: boolean; maxPct?: number; maxUsd?: number;
  stackable?: boolean; periodBudgetUsd?: number; roiFloor?: number; priceMatchMaxUsd?: number;
  subscriptionSelfServe?: SubscriptionSubAction[]; frequencyCapPerWeek?: number; quietHours?: QuietHours;
}
export interface PalupFloor {      // adds ONE new inviolable dimension: period spend-sanity
  maxAutoPct: number; maxAutoUsd?: number; massSendRecipientFloor: number;
  maxAutoPeriodUsd?: number;       // ad_spend spend-sanity per rolling period; merchant periodBudgetUsd clamped down to this
}
export interface RulePreset { id: string; label: string; vertical: string; description: string; envelope: MerchantRuleSet; }
export const CONSERVATIVE_DAY1_PRESET: RulePreset;
export const VERTICAL_PRESETS: readonly RulePreset[];      // Day-1 + one per supported vertical
export function listPresets(): readonly RulePreset[];       // [CONSERVATIVE_DAY1_PRESET, ...VERTICAL_PRESETS]
export function findPreset(id: string): RulePreset | undefined;

// @palup/merchant-console — app/api.ts (new ApiClient methods; MerchantRuleSet/CategoryRuleEnvelope/PalupFloor/RulePreset imported from @palup/platform-ports)
getRules(): Promise<{ envelope: MerchantRuleSet }>;
getFloors(): Promise<{ floors: Record<ProposalCategory, PalupFloor> }>;
listRulePresets(): Promise<{ presets: RulePreset[] }>;
putRules(patch: MerchantRuleSet): Promise<{ envelope: MerchantRuleSet; bigJump: boolean }>;
previewRules(patch: MerchantRuleSet): Promise<{ before: MerchantRuleSet; after: MerchantRuleSet; bigJump: boolean }>;
applyRulePreset(presetId: string): Promise<{ envelope: MerchantRuleSet; bigJump: boolean }>;
```

The three layers, made concrete: `PALUP_FLOORS[category]` (ceiling, `getFloors`) ⊇ merchant `CategoryRuleEnvelope` (`getRules`/`putRules`) ⊇ agent `AutoActLimit` (`clampToFloor(envelope, floor)`, what the classifier lets the agent do unattended). The console renders all three per category; the classifier enforces all three live.

---

### Task 1: Broaden the envelope + floor domain model (platform-ports)

Extend the stored/clamped shapes, add the period spend-sanity floor, extend `clampToFloor` (fail-closed) and `isBigJump`, and reconcile the W4-min tests the new default-merge touches. **`CONSERVATIVE_DEFAULTS` stays minimal** (only `allowedAuto:false` per category, unchanged) so `mergeOverDefaults({})` is byte-identical to today and existing route tests keep passing; the richer "useful" values live in the Day-1 preset (Task 2), and absent richer fields are handled fail-closed by `clampToFloor`/the classifier.

**Files:**
- Modify `packages/platform-ports/src/merchant-rules-store.ts` (types, `PALUP_FLOORS`, `clampToFloor`, `isBigJump`).
- Create `packages/platform-ports/test/merchant-rules-broaden.test.ts`.
- Modify `packages/platform-ports/test/merchant-rules-store.test.ts` **only if** an existing assertion pins the exact `AutoActLimit`/`clampToFloor` output shape (add the new fields there); do not touch assertions that still hold.

**Interfaces — Consumes:** nothing new. **Produces:** the extended `CategoryRuleEnvelope`/`AutoActLimit`/`PalupFloor`, `SubscriptionSubAction`, `QuietHours`, and the extended `clampToFloor`/`isBigJump` semantics pinned above.

**Steps:**

- [ ] **Write failing test** `packages/platform-ports/test/merchant-rules-broaden.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { clampToFloor, isBigJump, PALUP_FLOORS, type CategoryRuleEnvelope } from "../src/index.js";

describe("PALUP_FLOORS spend-sanity (period)", () => {
  it("ad_spend defines an inviolable rolling-period ceiling; other categories do not", () => {
    expect(PALUP_FLOORS.ad_spend.maxAutoPeriodUsd).toBe(5000);
    expect(PALUP_FLOORS.discount.maxAutoPeriodUsd).toBeUndefined();
  });
});

describe("clampToFloor — new dimensions, fail-closed", () => {
  it("clamps a merchant period budget DOWN to the spend-sanity floor and never above it", () => {
    const env: CategoryRuleEnvelope = { allowedAuto: true, periodBudgetUsd: 999_999, maxUsd: 100 };
    const out = clampToFloor(env, PALUP_FLOORS.ad_spend);
    expect(out.periodBudgetUsd).toBe(5000); // pulled down to floor
  });
  it("applies the spend-sanity ceiling even when the merchant set NO period budget (inviolable, not opt-in)", () => {
    const env: CategoryRuleEnvelope = { allowedAuto: true, maxUsd: 100 };
    expect(clampToFloor(env, PALUP_FLOORS.ad_spend).periodBudgetUsd).toBe(5000);
  });
  it("fails closed to 0 when the floor omits maxAutoPeriodUsd but the merchant set a budget", () => {
    const env: CategoryRuleEnvelope = { allowedAuto: true, periodBudgetUsd: 300 };
    const synthFloor = { maxAutoPct: 30, maxAutoUsd: 50, massSendRecipientFloor: 500 }; // no maxAutoPeriodUsd
    expect(clampToFloor(env, synthFloor).periodBudgetUsd).toBe(0);
  });
  it("clamps a price-match credit to the refund-abuse dollar floor and defaults an absent one to 0", () => {
    expect(clampToFloor({ allowedAuto: true, priceMatchMaxUsd: 10_000 }, PALUP_FLOORS.refund).priceMatchMaxUsd).toBe(200);
    expect(clampToFloor({ allowedAuto: true }, PALUP_FLOORS.refund).priceMatchMaxUsd).toBe(0);
  });
  it("passes merchant-only policy fields through unchanged (no floor for them)", () => {
    const env: CategoryRuleEnvelope = {
      allowedAuto: true, stackable: true, roiFloor: 4,
      subscriptionSelfServe: ["pause", "skip"], frequencyCapPerWeek: 2, quietHours: { startHour: 21, endHour: 9 },
    };
    const out = clampToFloor(env, PALUP_FLOORS.discount);
    expect(out.stackable).toBe(true);
    expect(out.roiFloor).toBe(4);
    expect(out.subscriptionSelfServe).toEqual(["pause", "skip"]);
    expect(out.frequencyCapPerWeek).toBe(2);
    expect(out.quietHours).toEqual({ startHour: 21, endHour: 9 });
  });
  it("never widens allowedAuto (existing invariant preserved)", () => {
    expect(clampToFloor({ allowedAuto: false, stackable: true }, PALUP_FLOORS.discount).allowedAuto).toBe(false);
  });
});

describe("isBigJump — new autonomy-increasing dimensions", () => {
  const off: CategoryRuleEnvelope = { allowedAuto: false };
  it("flags enabling stacking", () => {
    expect(isBigJump({ allowedAuto: true, stackable: false }, { allowedAuto: true, stackable: true })).toBe(true);
  });
  it("flags adding 'cancel' to subscription self-serve", () => {
    expect(isBigJump({ allowedAuto: true, subscriptionSelfServe: ["pause"] }, { allowedAuto: true, subscriptionSelfServe: ["pause", "cancel"] })).toBe(true);
  });
  it("flags LOWERING the ROI floor (agent may auto-buy worse ROI = more autonomy)", () => {
    expect(isBigJump({ allowedAuto: true, roiFloor: 4 }, { allowedAuto: true, roiFloor: 2 })).toBe(true);
  });
  it("flags a big period-budget or price-match increase, and a frequency-cap increase", () => {
    expect(isBigJump({ allowedAuto: true, periodBudgetUsd: 100 }, { allowedAuto: true, periodBudgetUsd: 400 })).toBe(true);
    expect(isBigJump({ allowedAuto: true, priceMatchMaxUsd: 20 }, { allowedAuto: true, priceMatchMaxUsd: 200 })).toBe(true);
    expect(isBigJump({ allowedAuto: true, frequencyCapPerWeek: 1 }, { allowedAuto: true, frequencyCapPerWeek: 5 })).toBe(true);
  });
  it("does NOT flag a tightening (raising the ROI floor, shrinking a budget, removing 'cancel')", () => {
    expect(isBigJump({ allowedAuto: true, roiFloor: 2 }, { allowedAuto: true, roiFloor: 5 })).toBe(false);
    expect(isBigJump({ allowedAuto: true, periodBudgetUsd: 400 }, { allowedAuto: true, periodBudgetUsd: 100 })).toBe(false);
    expect(isBigJump({ allowedAuto: true, subscriptionSelfServe: ["pause", "cancel"] }, { allowedAuto: true, subscriptionSelfServe: ["pause"] })).toBe(false);
  });
  it("still flags the off→on allowedAuto flip (existing behavior)", () => {
    expect(isBigJump(off, { allowedAuto: true })).toBe(true);
  });
});
```

- [ ] **Run** `PGVECTOR_TESTCONTAINER=off pnpm exec vitest run packages/platform-ports/test/merchant-rules-broaden.test.ts` → **fail** (new fields/floor don't exist yet).

- [ ] **Minimal impl** — in `packages/platform-ports/src/merchant-rules-store.ts`:

Add the new types near `CategoryRuleEnvelope`:
```ts
export type SubscriptionSubAction = "pause" | "skip" | "cancel";
export interface QuietHours { startHour: number; endHour: number; }
```
Extend `CategoryRuleEnvelope` and `AutoActLimit` with the optional fields exactly as pinned in Interfaces (append them below the existing `maxPct?`/`maxUsd?`; JSDoc each per the pinned comments). Extend `PalupFloor` with `maxAutoPeriodUsd?: number;`. Add `maxAutoPeriodUsd` to the `ad_spend` entry of `PALUP_FLOORS` (only ad_spend):
```ts
ad_spend: { maxAutoPct: 100, maxAutoUsd: 500, maxAutoPeriodUsd: 5000, massSendRecipientFloor: 500 },
```
Extend `clampToFloor` (fail-closed, mirroring the existing `maxUsd` discipline) — the new tail before the `return`:
```ts
export function clampToFloor(envelope: CategoryRuleEnvelope, floor: PalupFloor): AutoActLimit {
  const maxPct = Math.min(envelope.maxPct ?? floor.maxAutoPct, floor.maxAutoPct);
  const maxUsd = floor.maxAutoUsd !== undefined ? Math.min(envelope.maxUsd ?? floor.maxAutoUsd, floor.maxAutoUsd) : 0;
  // Spend-sanity: an inviolable per-period ceiling that applies EVEN when the merchant set no budget
  // (fail-closed to 0 if the floor itself omits it — an absent platform ceiling is never "unlimited").
  const periodBudgetUsd = floor.maxAutoPeriodUsd !== undefined
    ? Math.min(envelope.periodBudgetUsd ?? floor.maxAutoPeriodUsd, floor.maxAutoPeriodUsd)
    : (envelope.periodBudgetUsd !== undefined ? 0 : undefined);
  // Price-match rides the refund-abuse dollar floor; absent merchant value ⇒ 0 (no auto price-match).
  const priceMatchMaxUsd = floor.maxAutoUsd !== undefined
    ? Math.min(envelope.priceMatchMaxUsd ?? 0, floor.maxAutoUsd)
    : 0;
  return {
    maxPct, maxUsd, allowedAuto: envelope.allowedAuto && withinFloor(floor),
    ...(periodBudgetUsd !== undefined ? { periodBudgetUsd } : {}),
    priceMatchMaxUsd,
    // merchant-only dimensions have no floor — pass through unchanged (undefined stays undefined)
    ...(envelope.stackable !== undefined ? { stackable: envelope.stackable } : {}),
    ...(envelope.roiFloor !== undefined ? { roiFloor: envelope.roiFloor } : {}),
    ...(envelope.subscriptionSelfServe !== undefined ? { subscriptionSelfServe: envelope.subscriptionSelfServe } : {}),
    ...(envelope.frequencyCapPerWeek !== undefined ? { frequencyCapPerWeek: envelope.frequencyCapPerWeek } : {}),
    ...(envelope.quietHours !== undefined ? { quietHours: envelope.quietHours } : {}),
  };
}
```
Extend `isBigJump` (append before the final `return false;`):
```ts
export function isBigJump(before: CategoryRuleEnvelope, after: CategoryRuleEnvelope): boolean {
  if (!before.allowedAuto && after.allowedAuto) return true;
  if (after.maxPct !== undefined && after.maxPct - (before.maxPct ?? 0) > BIG_JUMP_PCT_DELTA) return true;
  if (after.maxUsd !== undefined && after.maxUsd - (before.maxUsd ?? 0) > BIG_JUMP_USD_DELTA) return true;
  if (!before.stackable && after.stackable) return true;
  if (after.periodBudgetUsd !== undefined && after.periodBudgetUsd - (before.periodBudgetUsd ?? 0) > BIG_JUMP_USD_DELTA) return true;
  if (after.priceMatchMaxUsd !== undefined && after.priceMatchMaxUsd - (before.priceMatchMaxUsd ?? 0) > BIG_JUMP_USD_DELTA) return true;
  // Lowering the ROI floor = the agent may auto-buy on WORSE economics ⇒ an autonomy increase.
  if (after.roiFloor !== undefined && before.roiFloor !== undefined && after.roiFloor < before.roiFloor) return true;
  if (after.frequencyCapPerWeek !== undefined && after.frequencyCapPerWeek - (before.frequencyCapPerWeek ?? 0) > 0) return true;
  // Adding a self-serve sub-action the agent couldn't do before (esp. "cancel").
  const beforeSelf = new Set(before.subscriptionSelfServe ?? []);
  if ((after.subscriptionSelfServe ?? []).some((a) => !beforeSelf.has(a))) return true;
  return false;
}
```

- [ ] **Run** the new test → **pass**. Then **run the whole platform-ports suite** `PGVECTOR_TESTCONTAINER=off pnpm exec vitest run packages/platform-ports` and reconcile any existing assertion that pinned the exact `clampToFloor` output object (add the new fields there; the numeric-only cases are unchanged because the new keys are conditionally spread).

- [ ] **Governance note (do not edit):** adding `maxAutoPeriodUsd` and its `5000` value is a **new inviolable floor number**. Adding a floor dimension is a routine broaden (it only *tightens*), but **changing an existing floor value looser** would be governance-touching — flag any such future change to a named human owner; this task only adds a new, tighter dimension.

- [ ] **Commit:** `feat(platform-ports): broaden rule envelope + floors (stacking, budget/ROI, price-match, subscription, comms) with fail-closed clamp`.

---

### Task 2: Day-1 + vertical presets (platform-ports)

Ship the conservative-but-useful Day-1 preset and one preset per supported vertical as pure constants. Presets are *shippable now*; the note that W3 aggregate data may later tune the numbers is documentation, not a dependency.

**Files:**
- Create `packages/platform-ports/src/rule-presets.ts`.
- Modify `packages/platform-ports/src/index.ts` (export the presets + helpers).
- Create `packages/platform-ports/test/rule-presets.test.ts`.

**Interfaces — Consumes:** `MerchantRuleSet`, `PALUP_FLOORS`, `clampToFloor` (Task 1). **Produces:** `RulePreset`, `CONSERVATIVE_DAY1_PRESET`, `VERTICAL_PRESETS`, `listPresets()`, `findPreset(id)`.

**Steps:**

- [ ] **Write failing test** `packages/platform-ports/test/rule-presets.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  CONSERVATIVE_DAY1_PRESET, VERTICAL_PRESETS, listPresets, findPreset,
  clampToFloor, PALUP_FLOORS, type ProposalCategory,
} from "../src/index.js";

describe("rule presets", () => {
  it("Day-1 is the first listed preset and every preset has a stable id + non-empty label/description", () => {
    const all = listPresets();
    expect(all[0]).toBe(CONSERVATIVE_DAY1_PRESET);
    for (const p of all) {
      expect(p.id).toMatch(/^[a-z0-9-]+$/);
      expect(p.label.trim()).not.toBe("");
      expect(p.description.trim()).not.toBe("");
    }
    expect(new Set(all.map((p) => p.id)).size).toBe(all.length); // ids unique
  });

  it("findPreset resolves by id and returns undefined for an unknown id", () => {
    expect(findPreset(CONSERVATIVE_DAY1_PRESET.id)).toBe(CONSERVATIVE_DAY1_PRESET);
    expect(findPreset("nope")).toBeUndefined();
  });

  it("Day-1 is conservative-but-useful: NO money category auto-acts, spend/discount/refund stay OFF", () => {
    const e = CONSERVATIVE_DAY1_PRESET.envelope;
    expect(e.discount?.allowedAuto ?? false).toBe(false);
    expect(e.ad_spend?.allowedAuto ?? false).toBe(false);
    expect(e.refund?.allowedAuto ?? false).toBe(false);
  });

  it("NO preset exceeds any PalUp floor (clamp is a no-op ⇒ preset already ≤ floor)", () => {
    for (const p of listPresets()) {
      for (const cat of Object.keys(p.envelope) as ProposalCategory[]) {
        const env = p.envelope[cat]!;
        const clamped = clampToFloor(env, PALUP_FLOORS[cat]);
        if (env.maxPct !== undefined) expect(clamped.maxPct).toBe(env.maxPct);
        if (env.maxUsd !== undefined) expect(clamped.maxUsd).toBe(env.maxUsd);
        if (env.periodBudgetUsd !== undefined) expect(clamped.periodBudgetUsd).toBe(env.periodBudgetUsd);
        if (env.priceMatchMaxUsd !== undefined) expect(clamped.priceMatchMaxUsd).toBe(env.priceMatchMaxUsd);
        expect(clamped.allowedAuto).toBe(env.allowedAuto); // never widened
      }
    }
  });

  it("ships a skincare vertical preset (the primary staging vertical)", () => {
    expect(VERTICAL_PRESETS.some((p) => p.vertical === "skincare")).toBe(true);
  });
});
```

- [ ] **Run** → **fail** (module missing).

- [ ] **Minimal impl** `packages/platform-ports/src/rule-presets.ts`:

```ts
import type { MerchantRuleSet } from "./merchant-rules-store.js";

/** A named starting envelope a merchant can adopt in one click (onboarding or the rules editor).
 *  `vertical: "all"` is the industry-agnostic Day-1 baseline; others are informed by (but not gated on)
 *  the W3 aggregate layer. Every preset is authored ≤ PALUP_FLOORS so `clampToFloor` is a no-op on it. */
export interface RulePreset {
  id: string;
  label: string;
  vertical: string;
  description: string;
  envelope: MerchantRuleSet;
}

/** Conservative-but-useful Day-1 (ratified §10): the agent may answer + make tiny in-policy nudges,
 *  but ALL spend/discount/refund stay approval-gated until earned. Comms carry safe guardrails
 *  (frequency cap + quiet hours) so that if the merchant later enables campaign auto-send, the blast
 *  radius is already fenced. Nothing here auto-spends a cent. */
export const CONSERVATIVE_DAY1_PRESET: RulePreset = {
  id: "day1-conservative",
  label: "Conservative (recommended)",
  vertical: "all",
  description: "Your agent answers shoppers and makes tiny in-policy nudges automatically. Every discount, refund, or ad-spend still comes to you for approval until you widen these rules.",
  envelope: {
    discount: { allowedAuto: false, maxPct: 10, stackable: false },
    ad_spend: { allowedAuto: false, roiFloor: 3, periodBudgetUsd: 0 },
    refund: { allowedAuto: false, maxUsd: 0, priceMatchMaxUsd: 0 },
    subscription: { allowedAuto: false, subscriptionSelfServe: ["pause", "skip"] },
    campaign: { allowedAuto: false, frequencyCapPerWeek: 2, quietHours: { startHour: 21, endHour: 9 } },
  },
};

/** Per-vertical starting points. Still conservative on money (auto OFF for discount/ad_spend/refund),
 *  differing only in the SHAPE of the guardrails a vertical tends to need (e.g. skincare's higher
 *  price-match tolerance, tighter comms cadence). Tunable later from W3 aggregate data — that tuning
 *  is a future data-driven follow-on, not a dependency of shipping these. */
export const VERTICAL_PRESETS: readonly RulePreset[] = [
  {
    id: "skincare",
    label: "Skincare & beauty",
    vertical: "skincare",
    description: "Tighter message cadence and a modest price-match allowance suited to repeat-purchase skincare.",
    envelope: {
      discount: { allowedAuto: false, maxPct: 15, stackable: false },
      ad_spend: { allowedAuto: false, roiFloor: 3, periodBudgetUsd: 0 },
      refund: { allowedAuto: false, maxUsd: 0, priceMatchMaxUsd: 25 },
      subscription: { allowedAuto: false, subscriptionSelfServe: ["pause", "skip"] },
      campaign: { allowedAuto: false, frequencyCapPerWeek: 2, quietHours: { startHour: 21, endHour: 9 } },
    },
  },
  {
    id: "apparel",
    label: "Apparel & accessories",
    vertical: "apparel",
    description: "Room for seasonal discounting depth with codes that never auto-stack; standard comms cadence.",
    envelope: {
      discount: { allowedAuto: false, maxPct: 20, stackable: false },
      ad_spend: { allowedAuto: false, roiFloor: 2.5, periodBudgetUsd: 0 },
      refund: { allowedAuto: false, maxUsd: 0, priceMatchMaxUsd: 0 },
      subscription: { allowedAuto: false, subscriptionSelfServe: [] },
      campaign: { allowedAuto: false, frequencyCapPerWeek: 3, quietHours: { startHour: 21, endHour: 8 } },
    },
  },
  {
    id: "supplements",
    label: "Supplements & wellness",
    vertical: "supplements",
    description: "Subscription-first: self-serve pause/skip, cancellations escalate; conservative discounting.",
    envelope: {
      discount: { allowedAuto: false, maxPct: 10, stackable: false },
      ad_spend: { allowedAuto: false, roiFloor: 3, periodBudgetUsd: 0 },
      refund: { allowedAuto: false, maxUsd: 0, priceMatchMaxUsd: 0 },
      subscription: { allowedAuto: false, subscriptionSelfServe: ["pause", "skip"] },
      campaign: { allowedAuto: false, frequencyCapPerWeek: 2, quietHours: { startHour: 21, endHour: 9 } },
    },
  },
];

export function listPresets(): readonly RulePreset[] {
  return [CONSERVATIVE_DAY1_PRESET, ...VERTICAL_PRESETS];
}

export function findPreset(id: string): RulePreset | undefined {
  return listPresets().find((p) => p.id === id);
}
```

Add to `packages/platform-ports/src/index.ts`:
```ts
export type { RulePreset } from "./rule-presets.js";
export { CONSERVATIVE_DAY1_PRESET, VERTICAL_PRESETS, listPresets, findPreset } from "./rule-presets.js";
```

- [ ] **Run** the preset test + the whole platform-ports suite → **pass**.
- [ ] **Commit:** `feat(platform-ports): conservative Day-1 + vertical rule presets (shippable, W3-tunable later)`.

---

### Task 3: Enforce categorical gates LIVE in the classifier (agent-runtime)

Wire the new **categorical** dimensions (discount **stacking**, refund **price-match**, subscription **sub-action**) into `classifyAction`, and pass them through `createRulesProvider`. Preserve every existing fail-closed invariant; the relaxation of invariant 4 is **additive** — a category-specific dimension now also counts as "measured," but its absence still defaults to `requires_approval`.

**Files:**
- Modify `packages/agent-runtime/src/classify.ts` (new category-specific gates + generalized "measured" check).
- Modify `packages/agent-runtime/src/rules.ts` (`createRulesProvider` already returns `clampToFloor(...)`, which now carries the new fields — verify, add JSDoc; no behavior change needed there since `clampToFloor` does the work).
- Create `packages/agent-runtime/test/classify-categorical-gates.test.ts`.

**Interfaces — Consumes:** extended `AutoActLimit` (Task 1). **Produces:** `classifyAction` enforcement of `stackable`/`priceMatchMaxUsd`/`subscriptionSelfServe`. Action-param contract (pinned): discount stacking via `action.params.stack === true` or a non-empty `action.params.stackWith` array; refund price-match via `action.params.priceMatch === true` (its `usd` is the credit); subscription via `action.params.subAction: "pause"|"skip"|"cancel"`.

**Steps:**

- [ ] **Write failing test** `packages/agent-runtime/test/classify-categorical-gates.test.ts` (mirror E1's existing classify test harness — a hand-built `RulesProvider` fake):

```ts
import { describe, it, expect } from "vitest";
import { classifyAction, type RulesProvider } from "../src/classify.js";
import type { AgentAction, AutoActLimit, PalupFloor } from "@palup/platform-ports";

const floor: PalupFloor = { maxAutoPct: 30, maxAutoUsd: 200, maxAutoPeriodUsd: 5000, massSendRecipientFloor: 500 };
function rules(limit: AutoActLimit): RulesProvider {
  return { autoActLimit: () => limit, palupFloor: () => floor };
}
const ctx = { tenantId: "t1" };

describe("discount stacking gate", () => {
  it("auto: an in-cap, non-stacked discount when merchant enabled auto", async () => {
    const a: AgentAction = { type: "issue_discount", params: { pct: 10 } };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true, maxPct: 20, stackable: false }));
    expect(r.decision).toBe("auto");
  });
  it("requires_approval: a stacked discount when stacking is not allowed", async () => {
    const a: AgentAction = { type: "issue_discount", params: { pct: 10, stack: true } };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true, maxPct: 20, stackable: false }));
    expect(r.decision).toBe("requires_approval");
    expect(r.boundaryReasons.some((b) => b.rule === "discount.stacking_not_allowed")).toBe(true);
  });
  it("auto: a stacked discount when the merchant DID allow stacking (and pct in cap)", async () => {
    const a: AgentAction = { type: "issue_discount", params: { pct: 10, stackWith: ["SUMMER"] } };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true, maxPct: 20, stackable: true }));
    expect(r.decision).toBe("auto");
  });
});

describe("refund price-match gate", () => {
  it("requires_approval: a price-match credit over the price-match cap (even if under the general refund cap)", async () => {
    const a: AgentAction = { type: "issue_refund", params: { usd: 50, priceMatch: true } };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true, maxUsd: 200, priceMatchMaxUsd: 25 }));
    expect(r.decision).toBe("requires_approval");
    expect(r.boundaryReasons.some((b) => b.rule === "refund.price_match_over_cap")).toBe(true);
  });
  it("auto: a price-match credit within both the price-match cap and the general refund cap", async () => {
    const a: AgentAction = { type: "issue_refund", params: { usd: 20, priceMatch: true } };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true, maxUsd: 200, priceMatchMaxUsd: 25 }));
    expect(r.decision).toBe("auto");
  });
  it("fails closed: a price-match with NO configured price-match cap requires approval", async () => {
    const a: AgentAction = { type: "issue_refund", params: { usd: 5, priceMatch: true } };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true, maxUsd: 200 })); // priceMatchMaxUsd undefined
    expect(r.decision).toBe("requires_approval");
    expect(r.boundaryReasons.some((b) => b.rule === "refund.price_match_over_cap")).toBe(true);
  });
});

describe("subscription sub-action gate", () => {
  it("auto: a self-serve pause when 'pause' is in the allow-list", async () => {
    const a: AgentAction = { type: "change_subscription", params: { subAction: "pause" } };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true, subscriptionSelfServe: ["pause", "skip"] }));
    expect(r.decision).toBe("auto");
  });
  it("requires_approval: a cancel that is not in the allow-list", async () => {
    const a: AgentAction = { type: "change_subscription", params: { subAction: "cancel" } };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true, subscriptionSelfServe: ["pause", "skip"] }));
    expect(r.decision).toBe("requires_approval");
    expect(r.boundaryReasons.some((b) => b.rule === "subscription.action_requires_approval")).toBe(true);
  });
  it("requires_approval: a subscription action with NO subAction param (unmeasured, invariant 4)", async () => {
    const a: AgentAction = { type: "change_subscription", params: {} };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true, subscriptionSelfServe: ["pause"] }));
    expect(r.decision).toBe("requires_approval");
  });
  it("requires_approval: self-serve action but merchant has auto OFF for subscription", async () => {
    const a: AgentAction = { type: "change_subscription", params: { subAction: "pause" } };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: false, subscriptionSelfServe: ["pause"] }));
    expect(r.decision).toBe("requires_approval");
  });
});
```

- [ ] **Run** → **fail**.

- [ ] **Minimal impl** in `packages/agent-runtime/src/classify.ts`. Keep the existing top of `classifyAction` (mass-send floor, invariant 2, `allowedAuto` check, pct/usd handling) **verbatim**. Change only: (a) the invariant-4 "unmeasured" gate to also accept a category-specific dimension, and (b) add the three categorical gates into the same `boundaryReasons` collection before the final decision. Add near the top-level helpers:

```ts
type CategoricalDim = "discount_stack" | "refund_price_match" | "subscription_sub_action";

/** True when this action carries a category-specific dimension the new gates below evaluate — so an
 *  action that is "measured" on a categorical dimension (e.g. a subscription pause with no pct/usd)
 *  is NOT rejected by invariant 4's pct/usd-only "unmeasured" default. Presence only — the gates
 *  themselves decide auto vs approval. */
function categoricalDimensionPresent(action: AgentAction, category: ProposalCategory): boolean {
  if (category === "discount") return action.params.stack === true || Array.isArray(action.params.stackWith);
  if (category === "refund") return action.params.priceMatch === true;
  if (category === "subscription") return typeof action.params.subAction === "string";
  return false;
}
```

Replace the invariant-4 block so it accounts for the categorical dimension:
```ts
  const pct = numericParam(action, "pct");
  const usd = numericParam(action, "usd");
  const hasCategorical = categoricalDimensionPresent(action, category);

  // Invariant 4 (preserved, generalized): a known category with NOTHING measurable — no pct, no usd,
  // AND no category-specific dimension — is uncertainty, not a free pass.
  if (pct === undefined && usd === undefined && !hasCategorical) {
    return {
      decision: "requires_approval",
      category,
      boundaryReasons: [{ rule: `${category}.unmeasured_action`, detail: "no pct/usd/categorical param present to evaluate against the auto-act limit" }],
    };
  }
```

Keep the existing `eligibleDimensions`/pct/usd blocks exactly as-is. Then, **after** the `usd` block and **before** the final `if (boundaryReasons.length > 0)`, add the categorical gates (they push onto the same `boundaryReasons`):
```ts
  // --- Categorical gates (W4-broaden): each fails CLOSED — an absent/empty policy ⇒ requires_approval.
  if (category === "discount") {
    const stacking = action.params.stack === true || (Array.isArray(action.params.stackWith) && action.params.stackWith.length > 0);
    if (stacking && !limit.stackable) {
      boundaryReasons.push({ rule: "discount.stacking_not_allowed", detail: "the agent tried to stack this discount but merchant rules do not allow auto-stacking" });
    }
  }
  if (category === "refund" && action.params.priceMatch === true) {
    const cap = limit.priceMatchMaxUsd ?? 0; // absent ⇒ 0, fail-closed
    if (usd === undefined || usd > cap) {
      boundaryReasons.push({ rule: "refund.price_match_over_cap", detail: `price-match credit usd=${usd ?? "n/a"} exceeds the auto price-match cap=${cap}` });
    }
  }
  if (category === "subscription") {
    const sub = typeof action.params.subAction === "string" ? action.params.subAction : undefined;
    const allowed = limit.subscriptionSelfServe ?? [];
    if (sub === undefined || !allowed.includes(sub as (typeof allowed)[number])) {
      boundaryReasons.push({ rule: "subscription.action_requires_approval", detail: `subscription subAction="${sub ?? "n/a"}" is not in the merchant self-serve allow-list [${allowed.join(", ")}]` });
    }
  }
```

- [ ] In `packages/agent-runtime/src/rules.ts`, add a one-line JSDoc note on `createRulesProvider` that `autoActLimit` now also returns the broadened policy fields (they flow straight through `clampToFloor` — no code change, since Task 1 extended that function). Verify by reading: no change to the `autoActLimit`/`palupFloor` bodies is required.

- [ ] **Run** the new test **and the full agent-runtime suite** `PGVECTOR_TESTCONTAINER=off pnpm exec vitest run packages/agent-runtime` → all **pass** (existing classify tests must stay green — they use disabled/pct-usd envelopes untouched by these additive gates).
- [ ] **Load `hitl-approval-gate`** and confirm no gate can flip a `requires_approval` to `auto`. **Commit:** `feat(agent-runtime): enforce discount-stacking, refund price-match & subscription sub-action gates live in classifier`.

---

### Task 4: Enforce numeric/window gates LIVE in the classifier (agent-runtime)

Add the **ad-spend ROI floor + period budget** and **comms quiet-hours + frequency** gates. All read from deterministic `action.params` (the producing agent supplies rolling-window counts / local send hour — this module stays a pure function). Fail-closed and additive, same as Task 3.

**Files:**
- Modify `packages/agent-runtime/src/classify.ts` (extend `categoricalDimensionPresent` + add the numeric/window gates).
- Create `packages/agent-runtime/test/classify-numeric-window-gates.test.ts`.

**Interfaces — Consumes:** extended `AutoActLimit` (Task 1). **Action-param contract (pinned):** ad-spend ROI via `action.params.roi: number`; ad-spend period spend so far via `action.params.periodSpentUsd: number` (the buy's own `usd` is added to it); comms send-hour via `action.params.sendLocalHour: number` (0–23); comms per-recipient cadence via `action.params.priorSendsThisWeek: number`.

**Steps:**

- [ ] **Write failing test** `packages/agent-runtime/test/classify-numeric-window-gates.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { classifyAction, type RulesProvider } from "../src/classify.js";
import type { AgentAction, AutoActLimit, PalupFloor } from "@palup/platform-ports";

const floor: PalupFloor = { maxAutoPct: 100, maxAutoUsd: 500, maxAutoPeriodUsd: 5000, massSendRecipientFloor: 500 };
const commsFloor: PalupFloor = { maxAutoPct: 100, maxAutoUsd: 100, massSendRecipientFloor: 500 };
const rules = (limit: AutoActLimit, f: PalupFloor = floor): RulesProvider => ({ autoActLimit: () => limit, palupFloor: () => f });
const ctx = { tenantId: "t1" };

describe("ad-spend ROI floor gate", () => {
  it("requires_approval: projected ROI below the merchant floor", async () => {
    const a: AgentAction = { type: "run_ad_campaign", params: { usd: 100, roi: 1.5 } };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true, maxUsd: 500, roiFloor: 3 }));
    expect(r.decision).toBe("requires_approval");
    expect(r.boundaryReasons.some((b) => b.rule === "ad_spend.roi_below_floor")).toBe(true);
  });
  it("auto: ROI at/above the floor and under both per-action and period budgets", async () => {
    const a: AgentAction = { type: "run_ad_campaign", params: { usd: 100, roi: 4, periodSpentUsd: 200 } };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true, maxUsd: 500, roiFloor: 3, periodBudgetUsd: 1000 }));
    expect(r.decision).toBe("auto");
  });
  it("requires_approval: this buy would push rolling-period spend over the budget", async () => {
    const a: AgentAction = { type: "run_ad_campaign", params: { usd: 400, roi: 5, periodSpentUsd: 800 } };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true, maxUsd: 500, roiFloor: 3, periodBudgetUsd: 1000 }));
    expect(r.decision).toBe("requires_approval");
    expect(r.boundaryReasons.some((b) => b.rule === "ad_spend.period_budget_exceeded")).toBe(true);
  });
  it("period budget is inviolable: even with no merchant budget set, the spend-sanity floor caps it", async () => {
    // clampToFloor gives periodBudgetUsd=5000 when merchant left it unset; a $6000 running total trips it.
    const a: AgentAction = { type: "run_ad_campaign", params: { usd: 100, roi: 5, periodSpentUsd: 6000 } };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true, maxUsd: 500, roiFloor: 3, periodBudgetUsd: 5000 }));
    expect(r.decision).toBe("requires_approval");
  });
});

describe("comms quiet-hours & frequency gates", () => {
  it("requires_approval: an auto-send inside quiet hours (wraps midnight)", async () => {
    const a: AgentAction = { type: "send_campaign", params: { usd: 0, sendLocalHour: 23 } };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true, quietHours: { startHour: 21, endHour: 9 } }, commsFloor));
    expect(r.decision).toBe("requires_approval");
    expect(r.boundaryReasons.some((b) => b.rule === "campaign.quiet_hours")).toBe(true);
  });
  it("requires_approval: a recipient already at the weekly frequency cap", async () => {
    const a: AgentAction = { type: "send_campaign", params: { usd: 0, sendLocalHour: 12, priorSendsThisWeek: 2 } };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true, frequencyCapPerWeek: 2 }, commsFloor));
    expect(r.decision).toBe("requires_approval");
    expect(r.boundaryReasons.some((b) => b.rule === "campaign.frequency_cap")).toBe(true);
  });
  it("auto: a small in-window, under-cadence send (below the mass-send floor)", async () => {
    const a: AgentAction = { type: "send_campaign", params: { usd: 0, sendLocalHour: 12, priorSendsThisWeek: 0 }, blastRadius: 3 };
    const r = await classifyAction(a, ctx, rules({ allowedAuto: true, frequencyCapPerWeek: 2, quietHours: { startHour: 21, endHour: 9 } }, commsFloor));
    expect(r.decision).toBe("auto");
  });
});
```

Note the comms case needs `campaign` to be auto-eligible on a dimension so invariant 4 doesn't fire first. Extend `categoricalDimensionPresent` to treat a comms send carrying `sendLocalHour`/`priorSendsThisWeek` as a measured categorical dimension (below).

- [ ] **Run** → **fail**.

- [ ] **Minimal impl** in `packages/agent-runtime/src/classify.ts`. Extend `categoricalDimensionPresent`:
```ts
  if (category === "ad_spend") return numericParam(action, "roi") !== undefined; // ROI/budget make an ad buy measurable beyond usd
  if (category === "campaign") return numericParam(action, "sendLocalHour") !== undefined || numericParam(action, "priorSendsThisWeek") !== undefined;
```
Add the gates alongside the Task-3 categorical block (same `boundaryReasons` collection):
```ts
  if (category === "ad_spend") {
    const roi = numericParam(action, "roi");
    if (limit.roiFloor !== undefined && roi !== undefined && roi < limit.roiFloor) {
      boundaryReasons.push({ rule: "ad_spend.roi_below_floor", detail: `projected roi=${roi} is below the merchant ROI floor=${limit.roiFloor}` });
    }
    // Rolling-period spend-sanity: (running total + this buy) must stay within the (clamped) period budget.
    if (limit.periodBudgetUsd !== undefined && usd !== undefined) {
      const priorPeriod = numericParam(action, "periodSpentUsd") ?? 0;
      if (priorPeriod + usd > limit.periodBudgetUsd) {
        boundaryReasons.push({ rule: "ad_spend.period_budget_exceeded", detail: `period spend ${priorPeriod}+${usd} exceeds the auto period budget=${limit.periodBudgetUsd}` });
      }
    }
  }
  if (category === "campaign") {
    const hour = numericParam(action, "sendLocalHour");
    if (limit.quietHours !== undefined && hour !== undefined && inQuietHours(hour, limit.quietHours)) {
      boundaryReasons.push({ rule: "campaign.quiet_hours", detail: `sendLocalHour=${hour} falls in quiet hours [${limit.quietHours.startHour}, ${limit.quietHours.endHour})` });
    }
    const prior = numericParam(action, "priorSendsThisWeek");
    if (limit.frequencyCapPerWeek !== undefined && prior !== undefined && prior >= limit.frequencyCapPerWeek) {
      boundaryReasons.push({ rule: "campaign.frequency_cap", detail: `recipient already received ${prior} auto-sends this week (cap=${limit.frequencyCapPerWeek})` });
    }
  }
```
Add the pure helper near the top:
```ts
/** True when `hour` is inside the [start, end) quiet window, handling a window that wraps midnight
 *  (start > end, e.g. 21→9 covers 21,22,23,0..8). Pure/deterministic — the caller supplies the
 *  recipient-local hour; this module never reads a clock. */
export function inQuietHours(hour: number, q: { startHour: number; endHour: number }): boolean {
  return q.startHour <= q.endHour ? hour >= q.startHour && hour < q.endHour : hour >= q.startHour || hour < q.endHour;
}
```

- [ ] **Run** the new test + full agent-runtime suite → **pass**.
- [ ] **Load `hitl-approval-gate`**; confirm additivity. **Commit:** `feat(agent-runtime): enforce ad-spend ROI/period-budget & comms quiet-hours/frequency gates live in classifier`.

---

### Task 5: Broaden the rules routes — per-category validation + floors + presets (merchant-backend)

Extend `PUT /rules` validation to accept the new per-category fields (rejecting fields on the wrong category), and add read routes for the inviolable floors and the preset catalog so the console can render the full three-layer editor.

**Files:**
- Modify `packages/merchant-backend/src/routes/rules.ts` (extend `validateRuleSetBody`; add `GET /rules/floors`, `GET /rules/presets`).
- Modify `packages/merchant-backend/test/rules-routes.test.ts` (add cases; existing cases unchanged — the new fields are optional and CONSERVATIVE_DEFAULTS is untouched).
- Modify `packages/merchant-backend/test/route-protection.test.ts` (`KNOWN_DATA_ROUTES` += the two GETs).

**Interfaces — Consumes:** `MerchantRulesStore`, `PALUP_FLOORS`, `listPresets` (from `@palup/platform-ports`), `requirePermission`. **Produces:** validated writes of the broadened envelope; `GET /rules/floors` → `{ floors: PALUP_FLOORS }` (console.view); `GET /rules/presets` → `{ presets: listPresets() }` (console.view).

**Steps:**

- [ ] **Write failing tests** — add to `packages/merchant-backend/test/rules-routes.test.ts`:

```ts
import { PALUP_FLOORS, listPresets } from "@palup/platform-ports";

describe("GET /rules/floors", () => {
  it("returns the inviolable PalUp floors (console.view floor)", async () => {
    const state = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const app = await buildServer({ store: state, rulesStore, identity: identityFor(viewer) });
    const res = await app.inject({ method: "GET", url: "/rules/floors", headers: { authorization: "Bearer good" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().floors.ad_spend.maxAutoPeriodUsd).toBe(PALUP_FLOORS.ad_spend.maxAutoPeriodUsd);
    await app.close();
  });
});

describe("GET /rules/presets", () => {
  it("lists Day-1 + vertical presets", async () => {
    const state = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const app = await buildServer({ store: state, rulesStore, identity: identityFor(viewer) });
    const res = await app.inject({ method: "GET", url: "/rules/presets", headers: { authorization: "Bearer good" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().presets.map((p: { id: string }) => p.id)).toEqual(listPresets().map((p) => p.id));
    await app.close();
  });
});

describe("PUT /rules — broadened fields", () => {
  it("accepts the full discount/ad_spend/refund/subscription/campaign policy", async () => {
    const state = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const app = await buildServer({ store: state, rulesStore, identity: identityFor(owner) });
    const res = await app.inject({
      method: "PUT", url: "/rules", headers: { authorization: "Bearer good" },
      payload: {
        discount: { allowedAuto: true, maxPct: 15, stackable: true },
        ad_spend: { allowedAuto: true, maxUsd: 300, roiFloor: 3, periodBudgetUsd: 1000 },
        refund: { allowedAuto: true, maxUsd: 50, priceMatchMaxUsd: 25 },
        subscription: { allowedAuto: true, subscriptionSelfServe: ["pause", "skip"] },
        campaign: { allowedAuto: false, frequencyCapPerWeek: 2, quietHours: { startHour: 21, endHour: 9 } },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().envelope.discount.stackable).toBe(true);
    expect(res.json().envelope.ad_spend.roiFloor).toBe(3);
    await app.close();
  });
  it("400s a field on the wrong category (stackable on refund)", async () => {
    const state = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const app = await buildServer({ store: state, rulesStore, identity: identityFor(owner) });
    const res = await app.inject({
      method: "PUT", url: "/rules", headers: { authorization: "Bearer good" },
      payload: { refund: { allowedAuto: true, stackable: true } },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
  it("400s a malformed quietHours (hour out of 0–23)", async () => {
    const state = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const app = await buildServer({ store: state, rulesStore, identity: identityFor(owner) });
    const res = await app.inject({
      method: "PUT", url: "/rules", headers: { authorization: "Bearer good" },
      payload: { campaign: { allowedAuto: false, quietHours: { startHour: 30, endHour: 9 } } },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
  it("400s an unknown subscriptionSelfServe value", async () => {
    const state = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const app = await buildServer({ store: state, rulesStore, identity: identityFor(owner) });
    const res = await app.inject({
      method: "PUT", url: "/rules", headers: { authorization: "Bearer good" },
      payload: { subscription: { allowedAuto: true, subscriptionSelfServe: ["explode"] } },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
```

- [ ] **Run** → **fail**.

- [ ] **Minimal impl** — in `packages/merchant-backend/src/routes/rules.ts`. Replace `validateRuleSetBody` with a per-category, per-field validator (keeps the "reason on failure, never echo the value" discipline). Add the field→category allow-list and per-field type checks:

```ts
import { PALUP_FLOORS, listPresets } from "@palup/platform-ports";
import type { SubscriptionSubAction } from "@palup/platform-ports";

const SUBSCRIPTION_ACTIONS: ReadonlySet<string> = new Set<SubscriptionSubAction>(["pause", "skip", "cancel"]);

// Which broadened fields are legal on which category (allowedAuto/maxPct/maxUsd are legal everywhere,
// same as W4-min). A field present on the wrong category is a 400 — never silently dropped or stored.
const CATEGORY_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  discount: new Set(["allowedAuto", "maxPct", "maxUsd", "stackable"]),
  ad_spend: new Set(["allowedAuto", "maxPct", "maxUsd", "roiFloor", "periodBudgetUsd"]),
  refund: new Set(["allowedAuto", "maxPct", "maxUsd", "priceMatchMaxUsd"]),
  subscription: new Set(["allowedAuto", "maxPct", "maxUsd", "subscriptionSelfServe"]),
  campaign: new Set(["allowedAuto", "maxPct", "maxUsd", "frequencyCapPerWeek", "quietHours"]),
  autonomy_scope: new Set(["allowedAuto", "maxPct", "maxUsd"]),
};

function isNum(v: unknown): v is number { return typeof v === "number" && Number.isFinite(v); }

function validateRuleSetBody(body: unknown): { ok: true; value: MerchantRuleSet } | { ok: false; reason: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, reason: "body must be an object" };
  const value: MerchantRuleSet = {};
  for (const [key, raw] of Object.entries(body as Record<string, unknown>)) {
    if (!VALID_CATEGORIES.has(key)) return { ok: false, reason: `unknown category: ${key}` };
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, reason: `${key}: envelope must be an object` };
    const env = raw as Record<string, unknown>;
    const allowed = CATEGORY_FIELDS[key];
    for (const f of Object.keys(env)) if (!allowed.has(f)) return { ok: false, reason: `${key}: field "${f}" is not valid for this category` };
    if (typeof env.allowedAuto !== "boolean") return { ok: false, reason: `${key}: allowedAuto must be a boolean` };
    const entry: CategoryRuleEnvelope = { allowedAuto: env.allowedAuto };
    if (env.maxPct !== undefined) { if (!isNum(env.maxPct) || env.maxPct < 0) return { ok: false, reason: `${key}: maxPct must be a number ≥ 0` }; entry.maxPct = env.maxPct; }
    if (env.maxUsd !== undefined) { if (!isNum(env.maxUsd) || env.maxUsd < 0) return { ok: false, reason: `${key}: maxUsd must be a number ≥ 0` }; entry.maxUsd = env.maxUsd; }
    if (env.stackable !== undefined) { if (typeof env.stackable !== "boolean") return { ok: false, reason: `${key}: stackable must be a boolean` }; entry.stackable = env.stackable; }
    if (env.periodBudgetUsd !== undefined) { if (!isNum(env.periodBudgetUsd) || env.periodBudgetUsd < 0) return { ok: false, reason: `${key}: periodBudgetUsd must be a number ≥ 0` }; entry.periodBudgetUsd = env.periodBudgetUsd; }
    if (env.roiFloor !== undefined) { if (!isNum(env.roiFloor) || env.roiFloor < 0) return { ok: false, reason: `${key}: roiFloor must be a number ≥ 0` }; entry.roiFloor = env.roiFloor; }
    if (env.priceMatchMaxUsd !== undefined) { if (!isNum(env.priceMatchMaxUsd) || env.priceMatchMaxUsd < 0) return { ok: false, reason: `${key}: priceMatchMaxUsd must be a number ≥ 0` }; entry.priceMatchMaxUsd = env.priceMatchMaxUsd; }
    if (env.frequencyCapPerWeek !== undefined) { if (!Number.isInteger(env.frequencyCapPerWeek) || (env.frequencyCapPerWeek as number) < 0) return { ok: false, reason: `${key}: frequencyCapPerWeek must be an integer ≥ 0` }; entry.frequencyCapPerWeek = env.frequencyCapPerWeek as number; }
    if (env.subscriptionSelfServe !== undefined) {
      const arr = env.subscriptionSelfServe;
      if (!Array.isArray(arr) || !arr.every((a) => typeof a === "string" && SUBSCRIPTION_ACTIONS.has(a))) return { ok: false, reason: `${key}: subscriptionSelfServe must be an array of ${[...SUBSCRIPTION_ACTIONS].join("|")}` };
      entry.subscriptionSelfServe = arr as SubscriptionSubAction[];
    }
    if (env.quietHours !== undefined) {
      const q = env.quietHours as Record<string, unknown>;
      const okHour = (h: unknown) => Number.isInteger(h) && (h as number) >= 0 && (h as number) <= 23;
      if (typeof q !== "object" || q === null || !okHour(q.startHour) || !okHour(q.endHour)) return { ok: false, reason: `${key}: quietHours must be { startHour, endHour } in 0–23` };
      entry.quietHours = { startHour: q.startHour as number, endHour: q.endHour as number };
    }
    value[key as ProposalCategory] = entry;
  }
  return { ok: true, value };
}
```
Add the two read routes inside `registerRulesRoutes`, above the existing `GET /rules`:
```ts
  app.get("/rules/floors", { preHandler: requirePermission("console.view") }, async () => ({ floors: PALUP_FLOORS }));
  app.get("/rules/presets", { preHandler: requirePermission("console.view") }, async () => ({ presets: listPresets() }));
```
(Import `SubscriptionSubAction`/`PALUP_FLOORS`/`listPresets` at the top; `CategoryRuleEnvelope`/`ProposalCategory`/`MerchantRuleSet` are already imported.)

- [ ] Add to `KNOWN_DATA_ROUTES` in `packages/merchant-backend/test/route-protection.test.ts`: `{ method: "GET", url: "/rules/floors" }`, `{ method: "GET", url: "/rules/presets" }`. Do **not** touch `AUTH_EXEMPT_PATHS`.

- [ ] **Run** `PGVECTOR_TESTCONTAINER=off pnpm exec vitest run packages/merchant-backend/test/rules-routes.test.ts packages/merchant-backend/test/route-protection.test.ts` → **pass** (route-protection's structural loop will also 401-check the two new routes automatically).
- [ ] **Commit:** `feat(merchant-backend): broaden PUT /rules validation + GET /rules/floors + /rules/presets`.

---

### Task 6: `POST /rules/preview` (big-jump dry-run) + `POST /rules/apply-preset` (merchant-backend)

Add the server side of big-jump confirmation (a **dry-run** that computes before/after/bigJump **without writing**, so the console can render "this lets the agent … up to X" before the sovereign write) and a one-call **apply-preset** that writes a preset's envelope with audited `merchant_set` provenance.

**Files:**
- Modify `packages/merchant-backend/src/routes/rules.ts` (add `POST /rules/preview`, `POST /rules/apply-preset`).
- Modify `packages/merchant-backend/test/rules-routes.test.ts` (add cases).
- Modify `packages/merchant-backend/test/route-protection.test.ts` (`KNOWN_DATA_ROUTES` += the two POSTs).

**Interfaces — Consumes:** `MerchantRulesStore`, `mergeOverDefaults`, `effectiveCategory`, `isBigJump`, `findPreset` (from `@palup/platform-ports`). **Produces:** `POST /rules/preview` (rules.edit) → `{ before, after, bigJump }` (no write); `POST /rules/apply-preset` (rules.edit) body `{ presetId }` → `{ envelope, bigJump }` (writes, audited, provenance `merchant_set`).

**Steps:**

- [ ] **Write failing tests** — add to `rules-routes.test.ts`:

```ts
describe("POST /rules/preview", () => {
  it("computes before/after/bigJump WITHOUT writing (a subsequent GET is unchanged)", async () => {
    const state = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const app = await buildServer({ store: state, rulesStore, identity: identityFor(manager) });
    const res = await app.inject({
      method: "POST", url: "/rules/preview", headers: { authorization: "Bearer good" },
      payload: { discount: { allowedAuto: true, maxPct: 15 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().bigJump).toBe(true); // off→on
    expect(res.json().after.discount.allowedAuto).toBe(true);
    // no write happened:
    const get = await app.inject({ method: "GET", url: "/rules", headers: { authorization: "Bearer good" } });
    expect(get.json().envelope.discount.allowedAuto).toBe(false);
    await app.close();
  });
  it("403s a viewer (needs rules.edit)", async () => {
    const state = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const app = await buildServer({ store: state, rulesStore, identity: identityFor(viewer) });
    const res = await app.inject({ method: "POST", url: "/rules/preview", headers: { authorization: "Bearer good" }, payload: { discount: { allowedAuto: true } } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("POST /rules/apply-preset", () => {
  it("writes the preset envelope, returns bigJump, audits it, and a GET reflects it", async () => {
    const state = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const app = await buildServer({ store: state, rulesStore, identity: identityFor(owner) });
    const res = await app.inject({ method: "POST", url: "/rules/apply-preset", headers: { authorization: "Bearer good" }, payload: { presetId: "skincare" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().envelope.discount.maxPct).toBe(15); // skincare preset value
    const audit = await state.readAudit({ tenantId: "t1" });
    expect(audit.some((r) => r.action === "rules.changed")).toBe(true);
    await app.close();
  });
  it("404s an unknown presetId", async () => {
    const state = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const app = await buildServer({ store: state, rulesStore, identity: identityFor(owner) });
    const res = await app.inject({ method: "POST", url: "/rules/apply-preset", headers: { authorization: "Bearer good" }, payload: { presetId: "nope" } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
```

- [ ] **Run** → **fail**.

- [ ] **Minimal impl** in `registerRulesRoutes` (import `mergeOverDefaults`, `effectiveCategory`, `isBigJump`, `findPreset` from `@palup/platform-ports`):

```ts
  app.post<{ Body: unknown }>("/rules/preview", { preHandler: requirePermission("rules.edit") }, async (req, reply) => {
    const ctx = { tenantId: req.principal!.merchantId };
    const validated = validateRuleSetBody(req.body);
    if (!validated.ok) return reply.code(400).send({ error: "invalid rule set", reason: validated.reason });
    const before = await deps.rulesStore.get(ctx); // defaults-merged effective envelope
    const after: MerchantRuleSet = { ...before };
    let bigJump = false;
    for (const [key, envPatch] of Object.entries(validated.value)) {
      if (!envPatch) continue;
      const cat = key as ProposalCategory;
      const beforeCat = before[cat] ?? { allowedAuto: false };
      const afterCat: CategoryRuleEnvelope = { ...beforeCat, ...envPatch };
      after[cat] = afterCat;
      if (isBigJump(beforeCat, afterCat)) bigJump = true;
    }
    return { before, after, bigJump };
  });

  app.post<{ Body: { presetId?: unknown } }>("/rules/apply-preset", { preHandler: requirePermission("rules.edit") }, async (req, reply) => {
    const ctx = { tenantId: req.principal!.merchantId };
    const presetId = req.body?.presetId;
    if (typeof presetId !== "string") return reply.code(400).send({ error: "presetId required" });
    const preset = findPreset(presetId);
    if (!preset) return reply.code(404).send({ error: "unknown preset" });
    const { envelope, bigJump } = await deps.rulesStore.set(ctx, preset.envelope, req.principal!.userId, "merchant_set");
    return { envelope, bigJump };
  });
```
(`effectiveCategory`/`mergeOverDefaults` are available if a reviewer prefers them over the inline spread; the inline `{ ...beforeCat, ...envPatch }` mirrors the store's own `applyPatch` exactly — keep them identical.)

- [ ] Add `{ method: "POST", url: "/rules/preview" }` and `{ method: "POST", url: "/rules/apply-preset" }` to `KNOWN_DATA_ROUTES`.
- [ ] **Run** the two test files → **pass**.
- [ ] **Commit:** `feat(merchant-backend): POST /rules/preview (big-jump dry-run) + /rules/apply-preset (audited)`.

---

### Task 7: Agent-initiated rule changes flow through W1 (agent-runtime + merchant-backend executor), dark

An agent must never mutate rules directly. Provide (a) a helper that builds the `AgentAction` for a proposed envelope expansion (classifies to `autonomy_scope` → `requires_approval` by the existing invariant 2, so it always becomes a `Proposal`), and (b) an executor branch that, on human approval, applies the patch via `rulesStore.set(..., "agent_proposed")`. Wire the branch into merchant-backend's approval executor. Built dark: no agent emits this action yet.

**Files:**
- Create `packages/agent-runtime/src/rule-change-proposal.ts` (`RULE_CHANGE_ACTION_TYPE`, `buildRuleChangeAction`, `applyRuleChangeFromProposal`).
- Modify `packages/agent-runtime/src/index.ts` (export them).
- Create `packages/agent-runtime/test/rule-change-proposal.test.ts`.
- Modify `packages/merchant-backend/src/engine-wiring.ts` — the fail-closed executor/validator **registry** the approve path builds `EngineDeps` from (`resolveExecutor`/`resolveValidator`/`buildEngineDeps`). This, NOT `approvals.ts`, is the integration seam (approvals.ts calls `buildEngineDeps({ actionType: proposal.action.type, category, ... })`). Add a `case RULE_CHANGE_ACTION_TYPE` to `resolveExecutor` (returns an executor that calls `applyRuleChangeFromProposal`) and a `case "autonomy_scope"` to `resolveValidator` (always-valid — the human approval IS the gate; no time-sensitive precondition). Add `rulesStore: MerchantRulesStore` to `EngineWiringDeps`/`BuildEngineDepsInput` and thread it through.
- Modify `packages/merchant-backend/src/routes/approvals.ts` — pass `rulesStore` into the `buildEngineDeps({ ... })` call (it's already a route dep, server.ts:251) so the new executor can resolve it. Read the exact `buildEngineDeps` call site (approvals.ts:217) first.
- Modify `packages/merchant-backend/test/*approvals*.test.ts` (add an execute-applies-rule-change case) — match the existing approvals test harness.

**Interfaces — Consumes:** `classifyAction`/`proposeOrExecute` (invariant 2 forces approval), `MerchantRulesStore.set`, the approvals `Executor` seam. **Produces:** `RULE_CHANGE_ACTION_TYPE = "change_rules"`; `buildRuleChangeAction(patch): AgentAction` (`{ type: "change_rules", params: { patch } }`, `irreversible: false`); `applyRuleChangeFromProposal(proposal, rulesStore, ctx, by): Promise<RuleSetChangeResult>`.

**Steps:**

- [ ] **Write failing test** `packages/agent-runtime/test/rule-change-proposal.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { classifyAction, type RulesProvider } from "../src/classify.js";
import { RULE_CHANGE_ACTION_TYPE, buildRuleChangeAction, applyRuleChangeFromProposal } from "../src/rule-change-proposal.js";
import { InMemoryMerchantRulesStore, InMemoryRuntimeStore, type PalupFloor } from "@palup/platform-ports";

const floor: PalupFloor = { maxAutoPct: 30, maxAutoUsd: 200, massSendRecipientFloor: 500 };
const permissiveRules: RulesProvider = { autoActLimit: () => ({ allowedAuto: true, maxPct: 100, maxUsd: 100000 }), palupFloor: () => floor };
const ctx = { tenantId: "t1" };

describe("agent-proposed rule change routes through W1", () => {
  it("a change_rules action ALWAYS classifies to requires_approval (autonomy_scope), even under permissive rules", async () => {
    const action = buildRuleChangeAction({ discount: { allowedAuto: true, maxPct: 25 } });
    expect(action.type).toBe(RULE_CHANGE_ACTION_TYPE);
    const r = await classifyAction(action, ctx, permissiveRules);
    expect(r.decision).toBe("requires_approval");
    expect(r.category).toBe("autonomy_scope");
  });

  it("applyRuleChangeFromProposal writes the patch with agent_proposed provenance + audit", async () => {
    const state = new InMemoryRuntimeStore();
    const store = new InMemoryMerchantRulesStore(state);
    const proposal = { action: buildRuleChangeAction({ discount: { allowedAuto: true, maxPct: 25 } }) } as any;
    const out = await applyRuleChangeFromProposal(proposal, store, ctx, "win_back_agent");
    expect(out.envelope.discount).toEqual({ allowedAuto: true, maxPct: 25 });
    const audit = await state.readAudit(ctx);
    const rec = audit.find((r) => r.action === "rules.changed");
    expect(rec).toBeDefined();
    expect((rec!.input as { provenance: string }).provenance).toBe("agent_proposed");
  });

  it("rejects a proposal whose action is not a change_rules action", async () => {
    const state = new InMemoryRuntimeStore();
    const store = new InMemoryMerchantRulesStore(state);
    const bad = { action: { type: "issue_discount", params: {} } } as any;
    await expect(applyRuleChangeFromProposal(bad, store, ctx, "agent")).rejects.toThrow();
  });
});
```

- [ ] **Run** → **fail**.

- [ ] **Minimal impl** `packages/agent-runtime/src/rule-change-proposal.ts`:

```ts
import type { AgentAction, Proposal, MerchantRuleSet, MerchantRulesStore, RuleSetChangeResult, RuntimeStateCtx } from "@palup/platform-ports";

/** The action type an agent uses to PROPOSE an envelope change. It is deliberately NOT in
 *  `ACTION_TYPE_CATEGORY` (classify.ts), so `categoryForAction` maps it to `autonomy_scope` and
 *  invariant 2 forces `requires_approval` — an agent can never auto-apply a rule change; a human must
 *  approve it in the Approval Center first (CLAUDE.md §3.1). */
export const RULE_CHANGE_ACTION_TYPE = "change_rules";

export function buildRuleChangeAction(patch: MerchantRuleSet): AgentAction {
  return { type: RULE_CHANGE_ACTION_TYPE, params: { patch }, irreversible: false };
}

/** Applies an approved rule-change proposal's patch via the store with `agent_proposed` provenance.
 *  Called ONLY from an approval executor (post human-approval) — never on the propose path. Throws if
 *  the proposal is not a well-formed change_rules action (defence in depth: the executor must not
 *  apply an arbitrary payload as a rule set). */
export async function applyRuleChangeFromProposal(
  proposal: Pick<Proposal, "action">,
  store: MerchantRulesStore,
  ctx: RuntimeStateCtx,
  by: string,
): Promise<RuleSetChangeResult> {
  if (proposal.action?.type !== RULE_CHANGE_ACTION_TYPE) {
    throw new Error(`applyRuleChangeFromProposal: not a ${RULE_CHANGE_ACTION_TYPE} action`);
  }
  const patch = (proposal.action.params as { patch?: unknown }).patch;
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    throw new Error("applyRuleChangeFromProposal: action.params.patch must be a rule set object");
  }
  return store.set(ctx, patch as MerchantRuleSet, by, "agent_proposed");
}
```
Export both + the const from `packages/agent-runtime/src/index.ts`.

- [ ] **Wire the executor (dark) in `engine-wiring.ts`.** Add `rulesStore` to `EngineWiringDeps` + `BuildEngineDepsInput`, thread it into the `wiring` object in `buildEngineDeps`. Extend the two fail-closed registries (never add a `default` branch that executes/validates something unregistered):

```ts
// resolveExecutor — new case (returns a closure with the executor signature `(input: ExecutorInput) => Promise<ExecutionResult>`):
    case RULE_CHANGE_ACTION_TYPE:
      return async (input) => {
        // The proposal already passed human approval + the kill/status guard in executeApproved.
        await applyRuleChangeFromProposal({ action: input.action }, deps.rulesStore, input.ctx, input.agentId);
        return { ok: true, detail: "rule change applied (agent_proposed, post-approval)" };
      };

// resolveValidator — new case (the human approval is the gate; no time-sensitive precondition to re-check):
    case "autonomy_scope":
      return async () => ({ valid: true });
```
Import `RULE_CHANGE_ACTION_TYPE`, `applyRuleChangeFromProposal` from `@palup/agent-runtime` and `MerchantRulesStore` from `@palup/platform-ports`. Then in `approvals.ts` add `rulesStore: deps.rulesStore` to the `buildEngineDeps({ ... })` call. Do not invent an executor signature — reuse `Executor`/`ExecutorInput` from `@palup/agent-runtime` exactly as `campaignExecutor` does.

- [ ] **Write the merchant-backend test** in the existing approvals test file: create a `change_rules` proposal (pending), approve it as an admin, assert `rulesStore.get` now reflects the patch and an `agent_proposed` `rules.changed` audit row exists. Mirror the file's existing proposal-fixture + approve-inject pattern.

- [ ] **Run** `PGVECTOR_TESTCONTAINER=off pnpm exec vitest run packages/agent-runtime/test/rule-change-proposal.test.ts packages/merchant-backend/test` → **pass**.
- [ ] **Load `hitl-approval-gate`**; confirm no auto path exists (invariant 2 + the executor only runs post-approval). **Commit:** `feat(agent-runtime,merchant-backend): agent-proposed rule changes route through W1 (dark, human-approved apply)`.

---

### Task 8: Console API client methods + types (merchant-console)

Add the five rules methods to `ApiClient` so the screen (Task 9/10) is a thin renderer over a typed client. Reuse the existing `request`/`toQuery`/error-mapping machinery.

**Files:**
- Modify `packages/merchant-console/src/app/api.ts` (import `MerchantRuleSet`/`CategoryRuleEnvelope`/`PalupFloor`/`RulePreset`/`ProposalCategory` from `@palup/platform-ports`; extend `ApiClient` + the returned object).
- Create `packages/merchant-console/src/app/api.rules.test.ts` (unit-test the new methods against a fake `fetch`, mirroring any existing api client test).

**Interfaces — Consumes:** the routes from Tasks 5–6. **Produces:** the five methods pinned in the header (`getRules`, `getFloors`, `listRulePresets`, `putRules`, `previewRules`, `applyRulePreset`).

**Steps:**

- [ ] **Write failing test** `packages/merchant-console/src/app/api.rules.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { makeApiClient } from "./api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const base = { baseUrl: "/api", getToken: async () => "tok" };

describe("api client — rules methods", () => {
  it("getRules GETs /rules and returns the envelope", async () => {
    const fetch = vi.fn(async () => jsonResponse({ envelope: { discount: { allowedAuto: false } } }));
    const api = makeApiClient({ ...base, fetch: fetch as unknown as typeof globalThis.fetch });
    const out = await api.getRules();
    expect(fetch).toHaveBeenCalledWith("/api/rules", expect.objectContaining({}));
    expect(out.envelope.discount!.allowedAuto).toBe(false);
  });

  it("putRules PUTs the patch and returns { envelope, bigJump }", async () => {
    const fetch = vi.fn(async () => jsonResponse({ envelope: { discount: { allowedAuto: true, maxPct: 15 } }, bigJump: true }));
    const api = makeApiClient({ ...base, fetch: fetch as unknown as typeof globalThis.fetch });
    const out = await api.putRules({ discount: { allowedAuto: true, maxPct: 15 } });
    const [, init] = fetch.mock.calls[0];
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ discount: { allowedAuto: true, maxPct: 15 } });
    expect(out.bigJump).toBe(true);
  });

  it("previewRules POSTs to /rules/preview", async () => {
    const fetch = vi.fn(async () => jsonResponse({ before: {}, after: {}, bigJump: false }));
    const api = makeApiClient({ ...base, fetch: fetch as unknown as typeof globalThis.fetch });
    await api.previewRules({ ad_spend: { allowedAuto: true, roiFloor: 3 } });
    expect(fetch.mock.calls[0][0]).toBe("/api/rules/preview");
    expect(fetch.mock.calls[0][1].method).toBe("POST");
  });

  it("applyRulePreset POSTs the presetId", async () => {
    const fetch = vi.fn(async () => jsonResponse({ envelope: {}, bigJump: true }));
    const api = makeApiClient({ ...base, fetch: fetch as unknown as typeof globalThis.fetch });
    await api.applyRulePreset("skincare");
    expect(fetch.mock.calls[0][0]).toBe("/api/rules/apply-preset");
    expect(JSON.parse(fetch.mock.calls[0][1].body as string)).toEqual({ presetId: "skincare" });
  });

  it("getFloors and listRulePresets GET their paths", async () => {
    const fetch = vi.fn(async () => jsonResponse({ floors: {}, presets: [] }));
    const api = makeApiClient({ ...base, fetch: fetch as unknown as typeof globalThis.fetch });
    await api.getFloors();
    await api.listRulePresets();
    expect(fetch.mock.calls[0][0]).toBe("/api/rules/floors");
    expect(fetch.mock.calls[1][0]).toBe("/api/rules/presets");
  });
});
```

- [ ] **Run** → **fail**.

- [ ] **Minimal impl** in `packages/merchant-console/src/app/api.ts`. Add imports:
```ts
import type { MerchantRuleSet, PalupFloor, ProposalCategory, RulePreset } from "@palup/platform-ports";
```
Extend the `ApiClient` interface (append):
```ts
  getRules(): Promise<{ envelope: MerchantRuleSet }>;
  getFloors(): Promise<{ floors: Record<ProposalCategory, PalupFloor> }>;
  listRulePresets(): Promise<{ presets: RulePreset[] }>;
  putRules(patch: MerchantRuleSet): Promise<{ envelope: MerchantRuleSet; bigJump: boolean }>;
  previewRules(patch: MerchantRuleSet): Promise<{ before: MerchantRuleSet; after: MerchantRuleSet; bigJump: boolean }>;
  applyRulePreset(presetId: string): Promise<{ envelope: MerchantRuleSet; bigJump: boolean }>;
```
Implement in the returned object (reuse `request<T>`):
```ts
    async getRules() { return request<{ envelope: MerchantRuleSet }>("/rules"); },
    async getFloors() { return request<{ floors: Record<ProposalCategory, PalupFloor> }>("/rules/floors"); },
    async listRulePresets() { return request<{ presets: RulePreset[] }>("/rules/presets"); },
    async putRules(patch) { return request<{ envelope: MerchantRuleSet; bigJump: boolean }>("/rules", { method: "PUT", body: JSON.stringify(patch) }); },
    async previewRules(patch) { return request<{ before: MerchantRuleSet; after: MerchantRuleSet; bigJump: boolean }>("/rules/preview", { method: "POST", body: JSON.stringify(patch) }); },
    async applyRulePreset(presetId) { return request<{ envelope: MerchantRuleSet; bigJump: boolean }>("/rules/apply-preset", { method: "POST", body: JSON.stringify({ presetId }) }); },
```

- [ ] **Run** the api test + `pnpm --filter @palup/merchant-console build` (typecheck) → **pass**.
- [ ] **Commit:** `feat(merchant-console): typed api client for the broadened rules surface`.

---

### Task 9: The rules editor screen (merchant-console) — three-layer, honest states

Replace the `/rules` **stub** with a real screen: per-category cards rendering the three layers (PalUp ceiling, merchant envelope editable, "your agent may auto-act up to X" derived), driven by real API data with honest empty/loading/error states — **never fabricated demo numbers** (governance rule; the mockup's fake counts are omitted). Load the `palup-design-system` skill first; reuse `Card`/`Field`/`Input`/`Select`/`Switch`/`Note`/`Button`/`Badge` — invent no primitives. Match `palup-merchant-app.html`'s `#rules` layout, labels, and the ever-note copy.

**Files:**
- Create `packages/merchant-console/src/screens/rules/RulesEditor.tsx` (screen, `{ api }` prop).
- Create `packages/merchant-console/src/screens/rules/CategoryRuleCard.tsx` (one category's three-layer editor).
- Create `packages/merchant-console/src/screens/rules/format.ts` (`describeAutoGrant(category, env, floor)` → the "this lets the agent … up to X" sentence; pure, unit-testable).
- Modify `packages/merchant-console/src/App.tsx` (import `RulesEditor`, add `<Route path="/rules" element={<RulesEditor api={api} />} />`, **remove** `{ path: "/rules", title: "Automation Rules" }` from `STUB_ROUTES`). The `/rules` nav link already exists in `shell.tsx` — no nav change.
- Create `packages/merchant-console/src/screens/rules/RulesEditor.test.tsx`, `format.test.ts`.

**Interfaces — Consumes:** the Task-8 `ApiClient`. **Produces:** the `/rules` route.

**Steps:**

- [ ] **Write failing test** `packages/merchant-console/src/screens/rules/format.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { describeAutoGrant } from "./format";
import type { PalupFloor } from "@palup/platform-ports";

const discFloor: PalupFloor = { maxAutoPct: 30, maxAutoUsd: 50, massSendRecipientFloor: 500 };

describe("describeAutoGrant", () => {
  it("says approval-only when auto is off", () => {
    expect(describeAutoGrant("discount", { allowedAuto: false }, discFloor)).toMatch(/approval/i);
  });
  it("states the effective auto cap when on", () => {
    expect(describeAutoGrant("discount", { allowedAuto: true, maxPct: 15 }, discFloor)).toMatch(/15%/);
  });
  it("reflects the PalUp ceiling when the merchant sets above it (never claims more than the floor)", () => {
    expect(describeAutoGrant("discount", { allowedAuto: true, maxPct: 90 }, discFloor)).toMatch(/30%/); // clamped to floor
  });
});
```

- [ ] **Write failing test** `packages/merchant-console/src/screens/rules/RulesEditor.test.tsx`:

```ts
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ApiClient } from "../../app/api";
import { RulesEditor } from "./RulesEditor";

const floors = {
  discount: { maxAutoPct: 30, maxAutoUsd: 50, massSendRecipientFloor: 500 },
  ad_spend: { maxAutoPct: 100, maxAutoUsd: 500, maxAutoPeriodUsd: 5000, massSendRecipientFloor: 500 },
  refund: { maxAutoPct: 100, maxAutoUsd: 200, massSendRecipientFloor: 500 },
  campaign: { maxAutoPct: 100, maxAutoUsd: 100, massSendRecipientFloor: 500 },
  subscription: { maxAutoPct: 100, maxAutoUsd: 50, massSendRecipientFloor: 500 },
  autonomy_scope: { maxAutoPct: 0, maxAutoUsd: 0, massSendRecipientFloor: 500 },
} as const;

function fakeApi(over: Partial<ApiClient> = {}): ApiClient {
  return {
    getRules: vi.fn(async () => ({ envelope: { discount: { allowedAuto: false, maxPct: 10, stackable: false } } })),
    getFloors: vi.fn(async () => ({ floors: floors as any })),
    listRulePresets: vi.fn(async () => ({ presets: [] })),
    putRules: vi.fn(async () => ({ envelope: {}, bigJump: false })),
    previewRules: vi.fn(async () => ({ before: {}, after: {}, bigJump: false })),
    applyRulePreset: vi.fn(async () => ({ envelope: {}, bigJump: false })),
  } as unknown as ApiClient;
}

describe("RulesEditor", () => {
  it("renders the page header + the ever-note explainer from the mockup", async () => {
    render(<RulesEditor api={fakeApi()} />);
    expect(await screen.findByRole("heading", { name: /automation rules/i })).toBeInTheDocument();
    expect(screen.getByText(/anything above a rule's limit still comes to your approval center/i)).toBeInTheDocument();
  });

  it("renders a card per money category showing the PalUp ceiling (three-layer)", async () => {
    render(<RulesEditor api={fakeApi()} />);
    expect(await screen.findByText(/discount/i)).toBeInTheDocument();
    expect(screen.getByText(/PalUp caps this at 30%/i)).toBeInTheDocument(); // inviolable floor surfaced
  });

  it("shows an honest error state when the load fails — no fabricated values", async () => {
    const api = fakeApi();
    (api.getRules as any) = vi.fn(async () => { throw new Error("boom"); });
    render(<RulesEditor api={api} />);
    expect(await screen.findByText(/couldn't load your rules/i)).toBeInTheDocument();
  });
});
```

- [ ] **Run** both → **fail**.

- [ ] **Minimal impl** `packages/merchant-console/src/screens/rules/format.ts`:

```ts
import type { CategoryRuleEnvelope, PalupFloor, ProposalCategory } from "@palup/platform-ports";

const LABELS: Record<ProposalCategory, string> = {
  discount: "Discounts", ad_spend: "Ad spend", refund: "Refunds & price-match",
  campaign: "Campaigns & messaging", subscription: "Subscriptions", autonomy_scope: "Other actions",
};
export function categoryLabel(c: ProposalCategory): string { return LABELS[c]; }

/** One plain-language sentence for the "your agent may auto-act up to X" line — always reflecting the
 *  EFFECTIVE cap (merchant value clamped to the PalUp floor), never claiming more than the floor. */
export function describeAutoGrant(category: ProposalCategory, env: CategoryRuleEnvelope, floor: PalupFloor): string {
  if (!env.allowedAuto) return "Everything in this category comes to you for approval.";
  if (category === "discount") {
    const pct = Math.min(env.maxPct ?? floor.maxAutoPct, floor.maxAutoPct);
    return `Your agent can apply discounts up to ${pct}%${env.stackable ? ", stacking allowed" : ", never stacking"} automatically. Anything deeper needs your approval.`;
  }
  if (category === "refund") {
    const usd = Math.min(env.maxUsd ?? floor.maxAutoUsd ?? 0, floor.maxAutoUsd ?? 0);
    const pm = Math.min(env.priceMatchMaxUsd ?? 0, floor.maxAutoUsd ?? 0);
    return `Your agent can auto-refund up to $${usd} and price-match up to $${pm}. Larger amounts need your approval.`;
  }
  if (category === "ad_spend") {
    const perAction = Math.min(env.maxUsd ?? floor.maxAutoUsd ?? 0, floor.maxAutoUsd ?? 0);
    const period = Math.min(env.periodBudgetUsd ?? floor.maxAutoPeriodUsd ?? 0, floor.maxAutoPeriodUsd ?? 0);
    return `Your agent can auto-buy ads up to $${perAction} per action and $${period} per period, only at ${env.roiFloor ?? "—"}× ROI or better.`;
  }
  if (category === "subscription") {
    const acts = env.subscriptionSelfServe ?? [];
    return acts.length ? `Your agent can auto-handle: ${acts.join(", ")}. Anything else escalates to you.` : "All subscription changes escalate to you.";
  }
  if (category === "campaign") {
    const q = env.quietHours;
    return `Auto-sends respect a ${env.frequencyCapPerWeek ?? "—"}/week cap per person${q ? ` and quiet hours ${q.startHour}:00–${q.endHour}:00` : ""}. Bulk sends still need your approval.`;
  }
  return "This category always requires your approval.";
}
```

- [ ] `packages/merchant-console/src/screens/rules/CategoryRuleCard.tsx` — a `Card` per category rendering (1) the inviolable ceiling as read-only text (`PalUp caps this at {floor.maxAutoPct}% / ${floor.maxAutoUsd}`), (2) the editable merchant envelope (a `Switch` for `allowedAuto`; `Input`s for the numeric fields relevant to the category; a `Switch` for `stackable` on discount; `Switch`es for each `subscriptionSelfServe` action; two hour `Select`s for `quietHours`), and (3) the derived `describeAutoGrant(...)` sentence in a `Note variant="info"`. Emits an `onChange(category, patch)` up to the screen. Keep field visibility per-category (use `CATEGORY_FIELDS` mirror). Every input's value comes from props (controlled) — no fabricated defaults.

- [ ] `packages/merchant-console/src/screens/rules/RulesEditor.tsx` — the screen: on mount, `Promise.all([api.getRules(), api.getFloors(), api.listRulePresets()])`; loading → a `role="status"` spinner; failure → a `Note variant="dang"` "We couldn't load your rules — retry"; success → the page header (`<h1>Automation Rules</h1>` + the sub + the ever-`Note` copy from the mockup), a preset picker slot (filled in Task 10), and one `CategoryRuleCard` per money category (`discount`, `ad_spend`, `refund`, `subscription`, `campaign` — omit `autonomy_scope`, which is never merchant-editable). Hold edited patches in local state; a "Save changes" `Button` (disabled until dirty) calls the Task-10 confirm flow. Structure so Task 10 drops the confirm dialog + preset picker in without reshaping this file.

Minimal screen skeleton (Task 10 fills `onSave`/preset UI):
```tsx
import { useEffect, useState } from "react";
import { Button, Card, Note } from "@palup/design-system";
import type { ApiClient } from "../../app/api";
import type { MerchantRuleSet, PalupFloor, ProposalCategory } from "@palup/platform-ports";
import { CategoryRuleCard } from "./CategoryRuleCard";

const EDITABLE: ProposalCategory[] = ["discount", "ad_spend", "refund", "subscription", "campaign"];

export function RulesEditor({ api }: { api: ApiClient }) {
  const [envelope, setEnvelope] = useState<MerchantRuleSet | null>(null);
  const [floors, setFloors] = useState<Record<ProposalCategory, PalupFloor> | null>(null);
  const [error, setError] = useState(false);
  const [dirty, setDirty] = useState<MerchantRuleSet>({});

  useEffect(() => {
    let off = false;
    Promise.all([api.getRules(), api.getFloors()])
      .then(([r, f]) => { if (!off) { setEnvelope(r.envelope); setFloors(f.floors); } })
      .catch(() => { if (!off) setError(true); });
    return () => { off = true; };
  }, [api]);

  if (error) return <Note variant="dang">We couldn't load your rules. Please retry.</Note>;
  if (!envelope || !floors) return <div role="status" className="text-ink-3">Loading your rules…</div>;

  function onChange(cat: ProposalCategory, patch: Partial<MerchantRuleSet[ProposalCategory]>) {
    setDirty((d) => ({ ...d, [cat]: { ...(envelope![cat] ?? { allowedAuto: false }), ...(d[cat] ?? {}), ...patch } }));
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-xl font-semibold text-ink">Automation Rules</h1>
        <p className="mt-1 text-sm text-ink-3">Pre-authorize routine actions so your agent can move fast without pinging you — but only inside limits you set. Creating a rule is itself logged for audit.</p>
      </div>
      <Note variant="ever">Rules let you trade some control for speed — safely. Anything above a rule's limit still comes to your Approval Center. You can pause any rule instantly.</Note>
      {EDITABLE.map((cat) => (
        <CategoryRuleCard
          key={cat}
          category={cat}
          envelope={{ ...(envelope[cat] ?? { allowedAuto: false }), ...(dirty[cat] ?? {}) }}
          floor={floors[cat]}
          onChange={(patch) => onChange(cat, patch)}
        />
      ))}
      {/* Task 10: preset picker + Save w/ big-jump confirm mount here */}
      <Button variant="primary" disabled={Object.keys(dirty).length === 0}>Save changes</Button>
    </div>
  );
}
```

- [ ] In `App.tsx`: `import { RulesEditor } from "./screens/rules/RulesEditor";`, add the route, remove the `/rules` stub entry.
- [ ] **Run** the screen + format tests + `pnpm --filter @palup/merchant-console build` → **pass**. (Route-protection is server-side; no change here.)
- [ ] **Commit:** `feat(merchant-console): rules editor screen — three-layer, honest states, mockup-matched`.

---

### Task 10: Big-jump confirm dialog + preset picker (merchant-console)

Wire the sovereign-but-confirmed save: on "Save changes" call `previewRules(dirty)`; if `bigJump`, open a `Dialog` that states plainly "this lets your agent … up to X" (from `describeAutoGrant` on the previewed `after`) before the merchant confirms; then `putRules(dirty)`. Add a preset picker that previews + applies a preset the same way. Honest toasts; a `KilledError` surfaces the halt banner; no fabricated success.

**Files:**
- Create `packages/merchant-console/src/screens/rules/BigJumpConfirmDialog.tsx`.
- Create `packages/merchant-console/src/screens/rules/PresetPicker.tsx`.
- Modify `packages/merchant-console/src/screens/rules/RulesEditor.tsx` (wire `onSave` + mount the picker + dialog).
- Create `packages/merchant-console/src/screens/rules/BigJumpConfirmDialog.test.tsx`, extend `RulesEditor.test.tsx`.

**Interfaces — Consumes:** `api.previewRules`, `api.putRules`, `api.listRulePresets`, `api.applyRulePreset`; `useToast` (design-system). **Produces:** the confirm + preset UX.

**Steps:**

- [ ] **Write failing test** `BigJumpConfirmDialog.test.tsx`: renders the "this lets your agent … up to X" sentences for the changed categories; a "Confirm" button calls `onConfirm`; "Cancel" calls `onCancel` and does not.

- [ ] **Extend** `RulesEditor.test.tsx`:
  - Saving a **big-jump** change: `previewRules` returns `{ bigJump: true, after: {...} }` → the dialog appears; confirming calls `putRules` with the dirty patch; a success toast shows; dirty clears.
  - Saving a **non-big-jump** change: `previewRules` returns `{ bigJump: false }` → `putRules` is called **without** a dialog (sovereign + instant).
  - `putRules` throwing `KilledError` → the kill/halt message is shown, not a success toast.

- [ ] **Run** → **fail**.

- [ ] **Minimal impl:**
  - `BigJumpConfirmDialog.tsx`: a design-system `Dialog` listing, per changed category, `describeAutoGrant(category, after[category], floors[category])`; `Confirm`/`Cancel` buttons. Copy leads with "You're giving your agent more room:".
  - `PresetPicker.tsx`: a `Select` of `listRulePresets()` (label + description); "Apply preset" → `previewRules(preset.envelope)`; route through the same big-jump dialog; on confirm `applyRulePreset(preset.id)`. Empty preset list → hide the picker (honest, no placeholder).
  - `RulesEditor.tsx` `onSave`:
```tsx
async function onSave() {
  try {
    const preview = await api.previewRules(dirty);
    if (preview.bigJump) { setPending({ after: preview.after }); return; } // open dialog
    await commit(dirty);
  } catch (e) { toastError(e); }
}
async function commit(patch: MerchantRuleSet) {
  try {
    const res = await api.putRules(patch);
    setEnvelope(res.envelope); setDirty({}); setPending(null);
    toast({ title: "Rules updated", variant: "ever" });
  } catch (e) { toastError(e); } // KilledError → halt banner; ConflictError/ApiError → honest message
}
```
  `toastError` maps `KilledError`→"Agents are halted (Kill Switch armed) — rules were not changed", `ApiError`→its status message; never a success toast on failure.

- [ ] **Run** the rules screen suite + `pnpm --filter @palup/merchant-console build` → **pass**.
- [ ] Optional but recommended: launch via the `run` skill and eyeball `/rules` against `palup-merchant-app.html#rules` (layout/labels/copy parity; **no fake numbers**).
- [ ] **Commit:** `feat(merchant-console): big-jump confirm dialog + vertical-preset picker for automation rules`.

---

## Deferred human/legal/enablement gates

- **PalUp floor *loosening* is governance-touching.** This plan only *adds* a tighter inviolable dimension (`ad_spend.maxAutoPeriodUsd = 5000`). Any later change that *raises/relaxes* an existing floor value (discount-depth, refund-abuse, spend-sanity, mass-send) must route to a **named human owner** (HITL-boundary edit) — never a build-agent change. Flagged, not planned here.
- **Enabling any money category to auto-act in production** stays a §3 run-time enablement decision. Presets ship with every money category `allowedAuto:false`; a merchant turning one on (or an agent-proposed expansion being approved) is the product's own HITL flow — the *build* is dark, the *enablement* is the merchant's/owner's at run time.
- **Agent-proposed rule changes (Task 7)** are built dark: **no run-time agent emits a `change_rules` action yet.** Wiring a producing agent to propose envelope expansions (the trust ratchet) is a later agent-workstream + evolution-pipeline step, human-promoted.
- **W3-tuned preset numbers.** The vertical presets ship with hand-set conservative numbers. Replacing them with values derived from the W3 **aggregate** layer requires that layer's **consent/competitive-fairness legal review** (spec §13) before it feeds presets — deferred to the W3 aggregate-enablement gate.
- **Security-reviewer sign-off** required on Tasks 1, 3, 4, 7 before merge (money-boundary + agent-autonomy code) per §4/§12.

## Assumes from earlier blocks

- **W4-min** (`docs/superpowers/plans/2026-08-23-W4min-automation-rules.md`): the `CategoryRuleEnvelope`/`MerchantRuleSet`/`AutoActLimit`/`PalupFloor` types, `PALUP_FLOORS`/`CONSERVATIVE_DEFAULTS`/`clampToFloor`/`isBigJump`/`mergeOverDefaults`/`effectiveCategory`, `InMemoryMerchantRulesStore` + `PostgresMerchantRulesStore` (audited `set`), `createRulesProvider`, and the `GET/PUT /rules` route this plan broadens. **No rebuild** — every task extends these in place.
- **E1** (`agent-runtime`): `classifyAction` + its four fail-closed invariants (this plan adds gates, never weakens one), `categoryForAction`/`ACTION_TYPE_CATEGORY` (Task 7 relies on `change_rules` being *unmapped* → `autonomy_scope`), and `proposeOrExecute`/`Executor`/`executeApproved` (Task 7's approval-time apply).
- **W1** (Approval Center): the proposal→approval→execute loop and its executor seam in `merchant-backend/src/routes/approvals.ts` (Task 7 adds a branch; `rulesStore` is already threaded into `registerApprovalsRoutes`). Agent-proposed rule changes surface as normal `autonomy_scope` proposals in the existing queue — **no W1 UI change**.
- **F2/F3**: `requireMerchant`/`requirePermission`, the `Permission` union (`console.view`, `rules.edit` = manager+), the `merchantPlane` mount point + `route-protection.test.ts` structural guard, and `req.principal.merchantId` for tenant scoping.
- **F1 / design-system**: `Card`/`Field`/`Input`/`Select`/`Switch`/`Note`/`Button`/`Badge`/`Dialog`/`useToast` + the Tailwind token preset; `palup-merchant-app.html#rules` as the visual source of truth.
- **Producing-agent inputs (future).** The live comms/ad-spend gates read deterministic `action.params` the *producing agent* must supply — `sendLocalHour`, `priorSendsThisWeek` (rolling 7-day per-recipient count), `roi`, `periodSpentUsd` (rolling-period ad spend). Those windowed accruals are the agent's responsibility (via `RuntimeStatePort.incrementWindow`/`readStream`) in its own later workstream; until then the gates are correct-but-unexercised on those params (fail-closed: an action lacking a category dimension still requires approval). This plan does **not** build those producers.
