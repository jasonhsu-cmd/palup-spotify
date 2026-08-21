# Durable full-signal-engine enablement on staging

**Date:** 2026-08-21
**Status:** Design — awaiting review
**Plane:** Run-time agent behavior (build-time work; staging enablement). Touches HITL boundaries — see §2.
**Owner:** jason (governance-touching legs need a named human; see §2).

## 1. Goal & context

The shopper live-chat widget's decision engine is designed around a rich set of **signal axes**
(mood, relationship lifecycle, persona style/role, behavioral events, safety/support/injection class,
environment, cart, proactivity). A code-verified audit ("The Dormant Engine") found the design matches
the goal — *help Shopify merchants maximize revenue + build durable stickiness/moat* — but in the
running system **most axes are dormant or inert**: their detectors/producers are flag-gated off, absent,
or unwired. The enabled subset is a competent guardrailed sales bot; the axes that build the *compounding
moat* (memory, lifecycle, personalization) and drive *in-session revenue* (behavioral exit-intent) are
exactly the ones not producing signal.

**Owner directive (2026-08-21):** aim for **staging** (no real shoppers, pre-release). **Enable all axes
by default on staging.** Defer legal / human-only gates to prod. **Live chat must be durable.** Target: a
top-tier US sales agent with very high stickiness and the strongest defensible moat available (per
`docs/MOAT.md`, a *compounding* moat — accumulated per-merchant results + trust + cross-visit memory —
not a "perfect" one, which the doc says does not exist).

This spec turns "enable all axes durably on staging" into eight workstreams, each test-first (ATDD), each
shipping as its own gate-passed PR, all governed by a **durability invariant (§3)**.

## 2. Governance boundary (non-negotiable — CLAUDE.md §3)

Staging-only enablement. **Nothing in this spec promotes to prod, weakens a gate, or grants an agent
self-promotion.** Specifically:

- **Staging service only.** Every flip is scoped to `palup-widget-staging` via
  `.github/workflows/deploy-staging.yml` repo vars / workflow defaults. Prod is deployed nowhere and
  stays gated.
- **`promo` pitch stays code-guarded** (owner decision 2026-08-21). Enabling money pitches is limited to
  `upsell` + `subscription`; `promo` (invented-discount authority) remains a *code* guardrail, not a flag.
  This keeps the §3.1 money boundary intact.
- **Memory legal deferred to prod.** The Art-9 / D3-D4 legal sign-off, the carry-over / special-category
  paths, and prod memory enablement remain human-only per `docs/MEMORY-GO-LIVE-CHECKLIST.md`. This spec
  fixes one *security* defect (WS-D) but changes no legal gate.
- **`classifyFact` language gap is OUT of scope** (deferred to prod). It is Art-9-classification-sensitive
  and a prior owner ruling requires reconciliation before any fix. Noted as a known deferred risk (§6).
- **Governance-touching legs keep a named human owner** for merge: the `deploy-staging.yml` env changes
  and the WS-D memory-merge security fix. Routine build PRs auto-merge on green (owner directive
  2026-08-20) via `.claude/scripts/merge-gate.sh`.

## 3. Durability invariant (#0 — applies to every workstream)

Enabling axes *adds failure surface* (three model-port classifiers, a Shopify order-history lookup,
client timing events). None may be able to break the chat. Every workstream's acceptance criteria include:

1. **Every new producer is non-blocking and fail-open.** A classifier or lookup that errors or times out
   yields the *absent/degraded* signal and the chat still answers — never a 5xx, never a dropped reply.
   The established pattern to mirror: `classifyGuardSignals` (`guard-classifier.ts:94-147`) and
   `classifyPersonaStyle` (`brain.ts:544-581`) **never throw** — they return a degraded/undefined result
   in nested try/catch. New producers follow this exactly.
2. **Bounded per-turn latency budget (headline durability fix).** Today the reactive model call has
   **no timeout** (`vertex-adapter.ts` `complete()` has no timeout/retry; only `embed` does —
   `vertex-adapter.ts:392-435`). A slow model hangs the request. WS-E adds a config-driven timeout on the
   `complete()` path (mirroring the embed path's `cfg.timeoutMs`) so a slow model degrades via the
   existing graceful catch (`server.ts:3604-3618`) instead of hanging. Added classifiers run under their
   own timeouts and in parallel with each other where independent, under a total budget.
3. **No single dependency can down chat.** Shopify order-history (WS-B2), memory/vector, and each model
   classifier are isolated behind their port with a fallback path. Grounding already fails safe via the
   caching wrapper (`grounding-cache.ts:82-98`); WS-E upgrades cold-failure from fail-**closed**-empty to
   fail-**open** last-known-good (§WS-E).
4. **Kill-switch + BASIC mode honored.** Kill halts before any model call (`brain.ts:1381-1391`). BASIC
   mode (`atCap`, server-derived) suppresses only proactive/greeting/pitch spend while reactive chat keeps
   answering (`brain.ts:1765,1852,1857`). No new code path may bypass either.
5. **State survives retry/reconnect.** Session one-strikes/counters (`session.ts`) and the opener
   handshake (`loader-core.ts:222-232`, the landed #347 fix) stay intact; new client instrumentation must
   not reintroduce the dropped-greeting race.
6. **Durability is tested, not asserted.** Each producer gets a fault-injection test (timeout / error /
   malformed → chat still answers) plus a Layer-2 live-staging degradation check.

## 4. Workstreams

Each is an independent, test-first PR. "Consumer already built" means the brain reads the signal today; we
supply the missing producer/flag. File:line references are the grounded integration points.

### WS-A — Flip the built axes on (staging default)

Consumers exist; enable them. **Correction from grounding:** the three `DISPOSITION_*` controls are *not*
env-readable — they are hardcoded `false` literals at `server.ts:920`, wired only as `createBrain` params.
So each needs a small code change, not just a repo var.

- **A1. `DISPOSITION_STYLE`** (persona style + role directives; consumer `brain.ts:1966,1982`): add a
  `process.env.DISPOSITION_STYLE === "true"` read in `server.ts`, replace the literal `false` at
  `server.ts:920` (param position 8), add the `env:` line to `deploy-staging.yml` (+ update the
  `deploy-staging-env.test.ts` guard), default `true` for staging.
- **A2. `DISPOSITION_CLASSIFIER`** (persona-style model classifier; consumer `brain.ts:1956-1959`, doubly
  gated on A1): same wiring, param position 10. Fail-open already holds (`classifyPersonaStyle` never
  throws).
- **A3. `DISPOSITION_BEHAVIORAL`** (behavioral rungs rage/pitch_declined/repeat_question; consumer
  `brain.ts:1641,1846,2007`): same wiring, param position 9. (Client emission of the *timing* events is
  WS-B3; this flag lights up the events the brain can already derive.)
- **A4. `SERVER_GUARD_SIGNALS`** (semantic safety/injection/support classifier; `server.ts:751`): clean
  env flip — set `vars.SERVER_GUARD_SIGNALS=true` (repo var, `|| 'false'` fallback means the var wins) or
  the workflow default. Classifier constructed only when on (zero spend otherwise); `classifyGuardSignals`
  already fail-open.
- **A5. Catalog retrieval** (per-tenant two-gate registry): run the audited `pnpm catalog:enable --scope
  platform --on` and `--scope tenant:palup-skincare-jason --on` + `pnpm catalog:index`. Not an env flip;
  a data/CLI op with an audit row. (Already enabled for the demo tenant per prior work — verify, don't
  double-apply.)

**Acceptance:** each flag on for staging; a Layer-1 corpus case per axis proves the consumer now fires;
`deploy-staging-env.test.ts` updated and green; fault-injection (classifier timeout) proves fail-open.

### WS-B1 — Mood detector (new server-side producer)

Today `mood` is **client-supplied only** (`signals.ts:168`, echoed if a valid enum); no server detector.
Build `classifyMood(model, message, tenantId)` mirroring `classifyGuardSignals`:

- Model **port** call, `temperature:0`, `responseSchema` enum = the 7 `Mood` values (`types.ts:7-14`);
  nested try/catch, **never throws**, returns `{ mood?, degraded }`.
- Own metering agent type (mirror `GUARD_CLASSIFIER_AGENT_TYPE`); metered model port constructed only when
  on (mirror `server.ts:825-827`).
- New env flag `SERVER_MOOD_SIGNALS` read in `server.ts` (mirror `SERVER_GUARD_SIGNALS:751`), default
  `true` for staging; invoked per-turn alongside the guard classifier (`server.ts:3151-3154`), merged into
  **server-authored** `signals.mood` via `deriveServingSignals` (so it becomes unspoofable like
  `serverSafetyClass`, replacing the client echo).

**Acceptance:** frustrated/anxious/skeptical messages drive the existing mood brakes (`brain.ts:2031-2106`)
with a *server-derived* mood; client-supplied mood no longer trusted when the detector is on; timeout →
`degraded`, chat answers; runs within the latency budget.

### WS-B3 — Behavioral timing events (client producer + server pass-through)

**Three-layer gap** (grounded): the brain reads `signals.behavioral` (WS-A3), but `deriveServingSignals`
**never forwards `behavioral`** — a client array is silently dropped at the trust boundary. And the client
(`packages/widget/public/index.html`, single HTML/JS file) has **no timing instrumentation** — only
exit-intent (`mouseout`→top, `index.html:1301-1304`).

- **Client:** add dwell (time on a product/price region), hesitation (typing-then-deleting / long
  compose pause), idle_then_return (idle timer + focus/visibility-return) detectors; emit a `behavioral`
  array on the next `/chat` post; and where appropriate fire the existing `sendProactive`/exit-intent path
  so dwell/idle can trigger a proactive cart_recovery turn (`brain.ts:1834`). Cap frequency per session
  (mirror the exit-intent once-per-session `sessionStorage` guard).
- **Server:** teach `deriveServingSignals` (`signals.ts`) to accept and validate an incoming `behavioral`
  array against the `BehavioralEvent` enum (drop unknown values, exactly like the mood/proactiveTrigger
  whitelist) so it reaches the brain.

**Acceptance:** a client dwell/hesitation/idle event reaches `signals.behavioral` and drives the
behavioral rung; malformed values dropped, not thrown; no regression to the opener handshake; exit-intent
still fires. Highest in-session revenue lever — sequenced ahead of B2.

### WS-B2 — Relationship lifecycle (new commerce-port method + wiring)

Consumer fully built (`REL_VOICE` `brain.ts:478-486`, `selectPitch` keys on `signals.relationship`) for
all six stages; prod emits only `new`/`anonymous` (`signals.ts:201`). The live CAA adapter
(`shopify-customer-account-commerce.ts`) already queries the shopper's own `customer.orders` (dates,
totals, multi-order) and `subscriptionContracts` on the **shopper's OAuth grant — no `read_orders` admin
scope needed**. Gaps:

1. Add a `CommercePort` method exposing order **count** + first/last order dates (repeat / one_and_done /
   vip / lapsed all need count + recency; `subscriber` / `replenishment_due` derivable from existing
   `getSubscription` + `getRecentOrder`). Map it in the CAA adapter (raw GraphQL already returns the data)
   and the `MockCommerceAdapter` fixture.
2. Thread the commerce port + request principal into the `relationship` derivation (today
   `deriveServingSignals` gets no commerce handle).
3. Derive the lifecycle stage from {order count, last-order recency, subscription active}. **Fold
   `sessionRecency`** (new/returning/cross_day) into the same lookup via a last-seen timestamp keyed by the
   memory subject (net-new durable state) rather than building it standalone.

**Scope reality:** lifecycle lights up only for **signed-in** shoppers on the live CAA path; anonymous
stays `anonymous`. Staging needs CAA sign-in enabled + a test shopper with order history on the dev store.
Highest durable-moat lever.

**Acceptance:** a signed-in shopper with N orders + a subscription derives the correct stage; anonymous →
`anonymous`; commerce lookup failure/timeout → fall back to `new`/`anonymous`, chat answers (fail-open);
`sessionRecency` set from the same lookup.

### WS-C — Enable `upsell` + `subscription` pitches

`selectPitch` never returns the money-gated kinds today. Enable `upsell` + `subscription` on the clean
sales path (respecting all existing precedence: safety/support/kill/atCap/mood brakes, one-strike
pitch_declined). **`promo` stays gated** (code guardrail — no invented discounts). Small, surgical change
in the pitch-selection logic (`brain.ts` ~419-470 region).

**Acceptance:** a fitting context yields an `upsell`/`subscription` pitch; `promo` is never returned; a
declined pitch still arms the one-strike; atCap/kill still suppress.

### WS-B4′ — Environment signals (minimal: `entry`; `device` formatting)

Lowest ROI — **no brain consumer exists** for device/entry/sessionRecency (type-only fields fed by the
eval corpus). Keep minimal:

- **`entry`** (ad/organic/email/social/direct): client captures `document.referrer` + UTM params, forwards
  them; server rebuilds the trusted `entry` value in `deriveServingSignals`; build a *small* brain
  consumer (light context tailoring, style-only, never price/offers — FAIR-1). Modest revenue value.
- **`device`**: derive server-side from `user-agent`; consume as *response-formatting* only (shorter,
  tap-friendly on mobile).
- **`sessionRecency`**: delivered by WS-B2 (folded), not built here.

**Acceptance:** `entry`/`device` produced server-side and validated; brain tailoring is style-only and
passes a FAIR-1 test (no price/offer variation by environment); fail-open when headers absent. Sequenced
last; may be deferred without blocking A–C/B1–B3/D–E.

### WS-D — Memory-merge security fix (`healthDisclosed`)

`/memory/merge` gates Art-9 special-category carry-over on three legs; two are server-derived
(`consent2`, `consent2Source` via `lookupConsent`, `server.ts:2736-2738`), but **`healthDisclosed` is
client-asserted** (`server.ts:2749` `body.healthDisclosed === true`) — forgeable (MED-1, documented
`server.ts:2740-2748`). The route is live on staging (memory ON), so the forgeable leg is exposed.

Fix: make `healthDisclosed` a **server-recorded disclosure event** — written when the carry-over prompt
actually names health data — read here like the consent tiers, replacing the body boolean. Legal/Art-9
sign-off and `CARRY_OVER_PROMPT_ENABLED` remain deferred to prod; this is the *security* remediation only.

**Acceptance:** a forged `body.healthDisclosed:true` no longer carries special-category rows; only a
server-recorded disclosure does; ordinary-category merge unaffected; security-reviewer PASS. **Named human
owner merges** (governance-touching). Unblocks the ADR-0015 staging-memory VOID condition's *security*
leg (legal leg still deferred).

### WS-E — Durability hardening (cross-cutting)

1. **Model-call latency budget (headline):** add a config-driven timeout on the Vertex adapter
   `complete()` path (mirror the embed path `cfg.timeoutMs`/`Promise.race`, `vertex-adapter.ts:392-435`);
   on timeout, throw → the existing route catch (`server.ts:3604-3618`) returns a graceful 200 +
   `escalate` instead of hanging. Set a sane staging budget.
2. **Grounding fail-open:** change cold-failure from fail-closed-empty (`grounding-cache.ts:44-46`
   `safeEmpty` → `products:[]`) to serve **last-known-good** where available (retention already 7d,
   `grounding-cache.ts:70`). Must feed a *real* degraded catalog, never an empty product list (the
   "CONFIDENT FALSE ONE" risk, `brain.ts:1202-1211`); when no last-known-good exists, keep the brain's
   `ctx=undefined` + `grounding:unavailable` path (safer than empty).
3. **Verify the #347 opener handshake** (`loader-core.ts:222-232`) with a regression test — it is landed;
   do not re-fix.
4. **Classifier total budget:** ensure guard + mood (+ persona) classifiers run in parallel under a
   combined per-turn budget so "all axes on" holds response latency.

**Acceptance:** a slow model returns the graceful reply within budget (fault-injection test); grounding
cold-failure with a warm last-known-good serves a real degraded context; opener regression test green;
p95 turn latency with all classifiers on stays within target on Layer-2.

## 5. Testing strategy (ATDD — CLAUDE.md §4)

Test-first for every workstream. The Layer-1 behavioral harness (`packages/eval/src/widget-behavioral/`,
corpus `packages/eval/cases/widget-behavioral.json`) is the bed:

- **Unit / contract:** each new producer (mood, lifecycle, behavioral pass-through, entry/device) +
  the new `CommercePort` method contract + adapter mappings.
- **Behavioral corpus:** new cases per newly-live axis proving the consumer fires with a real signal.
- **Fault-injection (durability):** per producer — timeout / error / malformed → chat still answers;
  model-call timeout → graceful reply; grounding cold-failure → last-known-good.
- **Governance:** promo-never-returned; environment tailoring is FAIR-1 style-only; forged
  `healthDisclosed` rejected; staging-env guard test.
- **Layer-2 live staging:** the two-layer harness (`e2e/tests/widget-behavioral-live.spec.ts`) verifies
  each axis end-to-end against `palup-widget-staging`, including degradation.

Nothing merges below the coverage bar or with a red governance test; the full local gate
(`.claude/scripts/merge-gate.sh`) runs per PR.

## 6. Sequencing & deferred risks

**Recommended PR order:** **D → A → C → B1 → B3 → B2 → E → B4′**
(security first; cheap high-value flips; revenue pitches; mood; in-session behavioral revenue; durable-moat
lifecycle; durability hardening; lowest-ROI environment last).

**Known deferred risks (documented, not fixed here):**

- **`classifyFact` language gap** (`classifier.ts:34-49`, English keyword stems only): a non-English health
  disclosure classifies as `ordinary` and bypasses the Art-9 special-category gate. Art-9-sensitive; prior
  owner ruling requires reconciliation. Deferred to prod per the legal-deferral directive — but flagged as
  a live correctness/safety gap on staging memory.
- **B2 CAA dependency:** lifecycle needs CAA sign-in enabled on staging + a test shopper with order
  history; anonymous shoppers stay `anonymous`.
- **B4′ net-new behavior:** environment consumers don't exist; enabling them is new behavior design, not
  lighting up existing logic — lowest confidence, hence last and minimal.
- **No request-schema validation** (`server.ts:2766-2777` is a raw `as` cast): out of scope; the trust
  boundary is `deriveServingSignals`, which rebuilds/validates. Noted for a future hardening pass.

## 7. What this spec deliberately does NOT do

- Does not promote anything to production or change any prod flag.
- Does not enable `promo` / invented-discount authority.
- Does not change any legal gate, the memory go-live checklist, or `CARRY_OVER_PROMPT_ENABLED`.
- Does not fix the `classifyFact` language gap (deferred, Art-9-sensitive).
- Does not weaken any eval/HITL gate or grant an agent self-promotion.
