# ADR-0016: Subscription skip/pause self-serve — approved, preconditioned, NOT enacted

- **Status: Approved (classification) — NOT enacted.** The named owner approved boundary decision **B**:
  the shopper's own subscription **skip / pause** is a reversible, low-stakes, in-policy timing change and
  belongs in HITL-POLICY §2 *auto-allowed*; subscription **cancel** ends recurring revenue and stays
  merchant-approval. This ADR records that decision **and the enforcement prerequisites** an adversarial
  governance review surfaced. **No autonomous execution ships until every precondition below is met and
  `security-reviewer` + `agent-evolution-steward` sign off.** Until then, skip/pause is **human-routed,
  exactly like cancel** (unchanged behavior).
- **Owner (named):** jason.hsu@framy.co. **Plane:** run-time (shopper agent autonomy).
- **Money/business-model + agent-autonomy → governed** (CLAUDE.md §3, HITL-POLICY).

## Context — the decision and why it's not simply shippable

Subscription commerce on Shopify is dominated by **replenishment consumables** (coffee, skincare,
supplements, food, pet), where **skip/pause is an extremely common, reversible shopper action** and
**cancel is the retention-critical, revenue-ending event**. So auto-completing skip/pause removes real
friction while keeping cancel gated is the right target (decision **B**).

A first implementation (execute skip/pause via new `CommercePort.skipNextDelivery`/`pauseSubscription`,
confirm, flag it) was built and put through the two required governance reviewers **before merge**. Both
returned **BLOCK** — not on the decision, which they judged sound and correctly scoped, but on **missing
enforcement of the controls the decision relies on**. That build was reverted; this ADR captures what it
must satisfy.

## Decision

**B — reversible skip/pause is auto-allowed; cancel is merchant-approval.** Enacted only behind the
prerequisites below. This *refines* HITL-POLICY §1 (reversible vs money/business-model) for
subscriptions; it does not weaken it (HITL-POLICY §5). Cancel is unchanged (human-routed).

## Enforcement prerequisites (ALL required before enactment)

1. **Verified shopper identity (foundational).** A per-request, server-verified shopper principal —
   never client-set, never a constant. Today the widget token authenticates only the **merchant**
   (`widget-token-identity.ts` → `{ m: merchantId }`) and `relationship` is hardcoded `anonymous`, so the
   "verified-owned subscription" check is vacuous (a constant `shopperId = "shopper-demo"` compared to
   itself). An account-scoped mutation MUST authorize against a real owner, or a live subscription
   adapter behind the constant id becomes an IDOR. **This is an M2 identity subsystem, not a bolt-on.**
2. **Audited autonomous action.** The successful skip/pause must be written to the **immutable audit
   log** with actor / input / decision / **reversal path** (CLAUDE.md §3 rule 5). The reviewed build was
   **silent**: `isGovernanceRelevant()` returned false for its flags, so `buildAuditInput()` returned
   `null` and no row was written — a *regression* (the human-routed skip WAS audited). Fix: make
   `autonomous_action` (or any `reversal:*` flag) governance-relevant, emit a distinct action
   (`subscription.skip.autonomous` / `.pause.autonomous`), and derive the reversal path from the result —
   with a test that asserts an audit **row**, not just a Decision flag.
3. **Executable reversal capability.** "You can undo this anytime" must be real: a port `resume`/`unskip`
   method and a shopper path to invoke it. Reversibility is the whole basis for "auto-allowed" — it can't
   be an unbacked promise.
4. **Skip cap + idempotency.** A per-subscription cap (repeated skips must not become a *stealth cancel*;
   indefinite pause routes to merchant approval) and server-side idempotency per (subscription, cycle),
   independent of a client-supplied key.
5. **Affirmative-intent tightening.** Exclude negations/questions ("please **don't** skip", "**why did
   you** skip?") before an action auto-executes; consider an explicit confirmation turn.
6. **Feature flag / staged ramp.** The first autonomous money-adjacent action ships behind a flag with a
   canary ramp, independently disablable from (and in addition to) the kill switch.

## What was confirmed sound (keep for the enactment build)

- **Cancel firewall** — `cancel_subscription` is classified before `skip_subscription` and only ever
  routes to a human; no phrasing routes cancel into the execution path, and skip never becomes auto-cancel.
- **Kill precedence** — the kill switch returns upstream in `decide()` before support, so a killed session
  never reaches an autonomous action (test-covered).
- **Portability** — `SubscriptionActionResult` is vendor-neutral; the port abstraction leaks no Shopify types.
- **Evolution pipeline untouched** — a static, human-authored change via the normal dev pipeline; §5 gates intact.

## Live-adapter obligations (carry-forwards from the enactment review)

The enactment (mock-only, behind `SUBSCRIPTION_SELFSERVE`, gated on a verified shopper) passed both
governance reviews. Two items are **not defects in the mock slice** but MUST be satisfied by the future
real Shopify subscription adapter PR:

- **Atomic act-then-record (security A1).** The external mutation runs inside `session.send` *before* the
  audit row is committed in the per-turn tx — if that tx fails, a real mutation could go un-audited. Harmless
  with the in-process mock (a client retry is an idempotent no-op that still emits the flag), but the live
  adapter needs an **act-then-record-with-reconciliation / outbox** pattern so an executed mutation can never
  be permanently un-audited (§3 rule 5).
- **Adapter-level idempotency + concurrency.** The mock is idempotent single-threaded; the live adapter must
  implement per-(subscription, cycle) idempotency **atomically** so concurrent/retried skips cannot exceed
  the cap or double-execute (a stealth-cancel vector).
- (Done in the enactment, reinforced here: the fail-closed guard now asserts the call targets the verified
  principal's own id — ownership at the choke point, not only in the caller.)

## Consequences

- (+) The owner's boundary decision is recorded and unambiguous; the enactment build has a precise,
  review-derived checklist and can be re-reviewed against it.
- (−) The self-serve skip eval cases (SUP-09/10, GS-2, REL-5's `self-serve`/`honor-immediately`) stay
  failing until enactment — correctly, since passing them today would require shipping unaudited autonomy
  on an unauthenticated shopper (eval-theater).
- (−) The load-bearing prerequisite (#1, verified shopper identity) is a substantial M2 subsystem; decision
  B is effectively gated on it.
