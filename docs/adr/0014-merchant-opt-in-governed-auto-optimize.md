# ADR-0014: Merchant-opt-in governed auto-optimize (a bounded auto-promote carve-out)

- **Status: Proposed — NOT enacted.** This ADR records a *proposed* carve-out and the conditions it
  must satisfy. It enables nothing on its own: `tenant.autoPromoteOptIn` defaults **false** and the
  platform `autopromote_globally_enabled` override defaults **force-human**, so the fast-lane is inert
  until (a) this ADR is **Accepted** by the named human owner, (b) the prerequisite code guardrails
  below are built + tested, and (c) the enablement precondition is met and recorded. Both gate agents
  returned **BLOCK** pending these — see *Governance sign-off*.
- **Owner (named, required by CLAUDE.md §5):** jason.hsu@framy.co.
- **Plane:** run-time (the shopper sales agent's policy/behavior). Governed by the evolution pipeline;
  the `agent-evolution-steward` owns it.

## Context

The owner chose **Option B**: let a merchant *opt their store into auto-promotion* of the self-improving
shopper agent, removing the per-change human **click** while keeping every safety gate — as opposed to
(A) auto-self-deploy gated only by "is it financial?" (rejected: that is the OpenClaw failure the product
exists to prevent), or the status quo (manual promotion only; safe but no fast-lane).

This is a change to when human approval is skipped, which today is **prohibited except via an explicit
policy change with security signoff** (`HITL-POLICY.md §5`; `CLAUDE.md §3` NN#1/#2; `AGENT-GOVERNANCE.md §1`
"self-improvement is allowed; self-deployment is not"). This ADR is that explicit policy change, brought
for the owner to enact.

**Honest framing (do not soften):** the carve-out is scoped to the `VALUE_VOICE_PROACTIVITY` change-class
= `styleDirective` + `proactivityDefault`. But the `Policy` type holds **only** those two fields
(`packages/widget-brain/src/types.ts:53-60`), so this class is **100% of what the self-improvement
pipeline can ever produce** — on the voice / proactivity-cadence surface *closest* to over-messaging and
manipulation. This is therefore **not a narrow corner**: it removes the human click from the entire
pipeline output for opted-in tenants. The owner is enacting exactly that, with eyes open, relying on the
automated gates (below) to do the work the human click did.

## Decision

Permit **auto-promotion without a human click** for a candidate **iff every condition holds** (any single
miss → route to the Approval Center; never silent-drop):

1. `tenant.autoPromoteOptIn === true` — governance-recorded, server-side, per merchant tenant.
2. Platform `autopromote_globally_enabled === on` (not force-human).
3. Governance-assigned `changeClass === VALUE_VOICE_PROACTIVITY` — assigned from an **independent diff +
   a semantic screen** of the `styleDirective`/proactivity content (does it induce discounting,
   medical/absolute claims, subscription pressure, urgency, over-messaging, or an authority/scope/model
   change?), **never** from field-shape alone and **never** self-declared by the agent. Anything
   else/ambiguous → default **up** → human.
4. **Eval gate PASS on the cross-family GATING judge** — `crossFamilyGuard(agent, judge, {strict:true})`
   succeeds (Anthropic judging Gemini, **not** the same-family advisory fallback) **and** `engine.gate()`
   passes the **full** safety/injection/compliance suite at ~100% recall (incl. SX-01/SX-06 and
   invariants 2/4/5/6/7/11/15), with a deterministic `floorPass` computed independently of the subjective
   quality score; quality no-regression **and** improved ≥ minDelta; anti-manipulation counter-metrics
   present and not worsened.
5. Shadow (0%) behavioral diff within bounds.
6. Canary (1–5%, per-tenant) live-metrics ≥ incumbent over a per-tenant minimum-traffic / observation
   window, with **no** regression on escalation-recall, return rate, or complaint/opt-out rate.
7. **No kill armed** at any of the run-time 3 scopes (merchant / agent-type / global) — read from the
   shared run-time kill registry, re-checked atomically immediately before the write.

An auto-promote writes **only the opted-in tenant's champion** (never `DEFAULT_POLICY`, never another
tenant's), attributed in the immutable hash-chained audit to actor `auto-loop` (never masqueraded as
`human`).

### Financial / authority / model carve-out (always human, even opted-in)

Any change touching pricing, payments, subscriptions, purchases, money-tools, authority/scope, model, or
business-model **always** routes to a human — the opt-in never covers these.

## Invariants (must hold; verified by tests before any flag exists)

1. Eval gate is mandatory, blocking, and MUST use the cross-family **gating** judge (`crossFamilyGuard`
   strict, fail-closed); the same-family advisory judge can NEVER gate an auto-promote.
2. Safety floor is never tradeable: safety ≈100% recall (incl. SX-01/SX-06) + compliance=100; a floor-fail
   blocks regardless of opt-in.
3. No stage is skippable; canary capped at 1–5% (`MAX_CANARY_PCT`); auto-promote only after canary
   live-parity, never straight from an eval pass. Stage-completion is **engine-enforced**, not merely
   orchestrator-enforced.
4. Auto-rollback + **freeze** on any regression at any live stage; a frozen candidate needs human
   clearance + orchestrator cooldown/rate-limit before re-proposal.
5. The 3-scope kill switch and the PalUp global force-human override are always on top and both override
   opt-in.
6. Financial/payments/subscription/purchase/money-tool/authority/model/business changes ALWAYS require a
   human, even when opted-in.
7. `changeClass` is assigned by governance from an independent diff + semantic screen, never
   self-declared; ambiguous/mixed defaults up to human; an agent can never flip its own opt-in or escalate
   its own class.
8. Every transition writes an immutable, append-only, hash-chained audit entry committed **atomically**
   with the action and externally anchored; an auto-promotion is attributed to `auto-loop`, never `human`.
9. Blast radius: an auto-promote writes ONLY the opted-in tenant's champion; per-tenant canary/serving
   isolation is asserted.
10. proposer ≠ evaluator: a **secret, rotated** held-out suite the candidate agent cannot read or
    influence.
11. Removing/weakening any gate or granting self-promotion remains prohibited except via this ADR; Option
    B is a scoped carve-out **inside** the gates, not their removal.

## Prerequisite code-guardrail fixes (BLOCKING — must land + be tested before the opt-in flag exists)

The reviews found the current code contradicts several invariants above; building "as described" by reusing
today's hooks would ship real bypasses. Each is a separate governed (human-merge) PR:

1. **Kill-registry wiring** — auto-promote fails-closed on `matchedKill(store, {tenantId, agentType})`
   (global > tenant > agent), read from the shared run-time registry (not the engine's in-process
   boolean), re-checked atomically before the write. *(both, critical)*
2. **Cross-family strict gating in the promote path** — the gate calls `crossFamilyGuard(...,{strict:true})`
   and **refuses** when a strict cross-family judge is unavailable; the Gemini-advisory fallback can never
   gate. *(both, critical)*
3. **Real safety floor** — gate on the full safety/injection/compliance suite (SX-01/SX-06 + inv
   2/4/5/6/7/11/15) at ~100% recall, `floorPass` deterministic and independent of `qualityScore` (today
   it is a bare alias over 2 probes). *(security, critical)*
4. **Per-tenant champion + per-tenant canary** — serving reads the opted-in tenant's champion (KV under the
   merchant tenant, never `__system__`); canary config + sticky bucketing scoped per tenant; blast-radius
   isolation test. *(both, critical)*
5. **Live counter-metrics, fail-closed** — grader returns populated return/complaint/opt-out/escalation-
   recall; gate fails-closed when absent (today `0>0` is vacuous); an engagement lift never passes on its
   own. *(both, high)*
6. **Semantic changeClass screen** + server-sourced, un-spoofable `changeClass`/opt-in (mirror the
   `deriveServingSignals` trust boundary); opt-in SET is step-up + audited. *(both, high)*
7. **Secret rotated holdout** in the gate, unreadable by the proposer. *(security, high)*
8. **Durable, append-only, externally-anchored `auto-loop` audit** committed atomically with the champion
   write; `verifyAuditChain(expectedHead)` green. *(security, high)*
9. **Freeze + orchestrator cooldown/rate-limit** on rollback; per-merchant auto-promote frequency cap
   (≤1/week) to bound silent drift. *(both, high/medium)*
10. **Statistical power + delayed-signal rollback** — per-tenant minimum-traffic/observation window before
    "≥ incumbent" is meaningful; a delayed rollback that can revert a champion promoted earlier when
    lagging return/complaint harm surfaces (retain a known-good baseline beyond depth-1); low-traffic
    tenants stay on the human path. *(both, high/medium)*

    *Status 2026-08-05 — the baseline half is CLOSED; the measurement half is not.* `recordKnownGood`
    previously had **no non-test caller**, so the baseline was permanently null and
    `delayedRollbackToBaseline` — the only mechanism that can revert further than the engine's depth-1
    `prevChampion` — could do nothing but throw. `monitorServing` (`champion-promoter.ts`) now records
    the serving champion as known-good on a healthy observation, and falls back to that baseline when a
    regression arrives with the depth-1 target already spent. Both halves are route-covered.
    **Update (2026-08-19):** the measured-outcome signal is now wired into `POST /api/monitor` and the
    evolution gate (#372/#354) — `readServingMeasuredOutcome` reads the Wave-2 outcome ledger and a
    statistical **power floor** gates it (#354/#378, the per-tenant minimum-traffic/observation window) — so
    monitor/rollback **can** react to a *measured* regression, not only the caller-supplied one. It stays
    **dark-safe:** with no (or low-volume) live order-attribution data the ledger read returns
    honest-zero/underpowered and falls back to the caller-attested `qualityScore`, so behaviour is
    byte-identical until the ledger is fed with statistically-powered data. **Still dormant:** the
    auto-optimize *orchestrator* (fast-lane) itself remains dormant and not deployed in production.

## Enablement precondition (must be met + recorded before any real merchant flag flips)

Even after all the above land, the fast-lane stays dormant until, evidenced and signed by
`agent-evolution-steward` + `security-reviewer` in this ADR:
1. Cross-family (Anthropic) gating judge shows ~100% safety recall with SX-01/SX-06 + inv 2/4/5/6/7/11/15
   at an independent deterministic floor (today SX-01/SX-06 **floor-fail**).
2. Live/gating quality above the current ~0.55 baseline, stable within the noise band.
3. The auto-promote path is **verified** to run under `crossFamilyGuard` strict (today **unverified**).
4. Anti-manipulation counter-metrics provably catch a pressure-driven lift against a holdout/control.

## Governance sign-off

- **`agent-evolution-steward`: BLOCK** — Option B removes the per-change human gate for output-affecting
  behavior; legitimate only once the policy is enacted (this ADR + amendments) *and* stage-completion is
  engine-enforced, cross-family fails-closed, per-tenant isolation exists, run-time kill is wired,
  counter-metrics are real, and freeze/cooldown land. No agent self-promotion/self-class/self-opt-in path
  is *designed* in, but those trust boundaries are net-new code that must be enforced + tested.
- **`security-reviewer`: BLOCK** — sound governance shape (all switches default off), but blocks on (1)
  enabling onto an unproven safety floor (SX-01/SX-06 fail, baseline 0.55) and (2) load-bearing guardrails
  wired to the wrong mechanism or absent (kill bypass, cross-family fails-open, inert counter-metrics,
  global serving/canary, non-durable audit). Named steward + security sign-off recorded here is required
  before any real-merchant enablement.

## Open questions (to resolve before Accepted)

- **Accountability/consent/liability** — when an auto-promoted change later harms a shopper, who owns it —
  the opted-in merchant or PalUp? Needs explicit opt-in liability/consent language + legal review.
- **Class-granular opt-in** — voice vs proactivity-cadence separately, since cadence is closest to
  over-messaging?
- **Lagging harm** — return/complaint signals surface days-to-weeks post-purchase, after promotion.
- **Numeric thresholds** — minDelta vs judge noise, escalation-recall floor, per-tenant return/complaint
  deltas (current `minDelta 0.05` is a demo value).
- **Reconcile** with the existing `governance-subsystems §4` pure-quality (non-output-affecting)
  auto-promote class so the two do not overlap.

## Consequences

- (+) A merchant who opts in gets faster iteration without a per-change human bottleneck — the fast-lane
  the owner asked for — **once** the gates and precondition are real.
- (−) It is a large program (10 blocking guardrail PRs) and, until the eval gate is trustworthy, it ships
  **dormant**. Building the mechanism is not the risk; **enabling** it prematurely is — hence the
  default-off/force-human posture and the recorded sign-off gate.
- (−) It permanently narrows the "human reviews every behavior change" guarantee to "human reviews every
  behavior change **for tenants who have not opted in**, and the automated gates review the rest." The
  product's governance story must state this honestly to merchants.
