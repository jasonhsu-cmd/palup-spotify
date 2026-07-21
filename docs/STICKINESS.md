# Stickiness Strategy

PalUp targets **very high user stickiness**. This document states how the product earns it,
which existing surfaces deliver it, and — importantly — the guardrails that keep stickiness
*durable and healthy* rather than manufactured. Retention here is a design driver, not a
growth-hack bolt-on.

## 1. Thesis: stickiness = accumulated value × trust

The agent becomes an irreplaceable, personalized employee. Two forces compound:
- **Accumulated value** — memory, learned playbooks, and results that grow with tenure.
- **Trust** — the belief that the agent will act correctly and never do harm unsupervised.

Both must be *earned continuously*. Unlike normal SaaS, one bad autonomous action can erase
months of trust instantly, so the governance and reliability work (kill switch, HITL,
auto-rollback) is not separate from retention — **it is the retention substrate.**

## 2. The levers, by durability

| # | Lever | Why it sticks | Existing surface |
|---|---|---|---|
| 1 | **Agent memory as moat** | Customer histories, what converts for *this* store, past decisions. Leaving = restarting a new hire at zero. Compounds automatically with time. | "Agent Memory" (merchant console) |
| 2 | **Results dependency** | Turning the agent off has an immediate, measurable revenue cost (cart recovery, closed deals, nurture). | Revenue Home, Cart Recovery, Upsell |
| 3 | **Per-tenant compounding** | Self-improvement makes the agent measurably better at this specific business over time — a personalization curve competitors can't copy on day one. | Evolution pipeline (`docs/AGENT-GOVERNANCE.md`) |
| 4 | **Network / benchmark effects** | Peer comparison + privacy-safe cross-merchant learning lift every merchant's agent. Platform-level moat. | Benchmarks, Share Results |
| 5 | **Habit surface** | A light, valuable daily touchpoint (review proposals, see results). | Approval Center, Notifications |

Design priority: invest first in the levers highest on this list — they are the hardest for
a competitor to replicate and the least dependent on any single feature.

## 3. Guardrails — stickiness must be healthy, not manufactured

These are hard rules, not preferences. For a company aiming at a public-market valuation,
manipulative retention is a churn, reputation, and regulatory liability.

1. **Value, not lock-off.** Stickiness comes from accumulated value and results, never from
   making the product hard to leave. **Frictionless data + agent-memory export is a
   first-class feature** — and, paradoxically, it raises adoption confidence. It also falls
   naturally out of the portability principle (ADR-0001).
2. **No engagement-maxxing.** The self-improvement pipeline must never optimize for
   engagement/stickiness metrics at the expense of merchant (or customer) value. Agents that
   learn to over-message, nag, or dark-pattern-upsell are a **failed eval**, not a win. See
   the eval-gate guardrail in `docs/AGENT-GOVERNANCE.md` §5.
3. **Approvals must feel worth it.** The HITL boundary is friction, and friction is
   anti-stickiness. Do **not** weaken the money/model/business-model boundary to reduce
   friction. Instead reduce *unnecessary* friction: batch proposals, offer in-policy
   "approve all routine" defaults, smart-default the common case, and interrupt only for
   decisions that genuinely matter. Track approval-fatigue as a churn risk signal.
4. **Trust is sacred.** Reliability, the always-working kill switch, auto-rollback, and a
   clean audit trail are retention features. A single unsupervised bad action outweighs many
   good ones. Protect the downside first.

## 4. The metric trap (read this before adding a retention KPI)

Because run-time agents self-improve toward signals, **any stickiness/engagement metric you
expose to the optimization loop can be gamed.** Before promoting an agent change that moves
an engagement number, the eval gate must confirm the lift came from *more value delivered*,
not from more interruptions or pressure. Prefer outcome metrics that are hard to fake:
retained revenue, merchant-reported value, task success, and long-horizon retention over
short-horizon activity. When in doubt, measure the merchant's outcome, not the agent's
activity.

## 5. What to track (business monitor)

Durable: net revenue retention, agent-attributed revenue per merchant, memory depth /
tenure, feature-of-value adoption, long-horizon (90/180-day) retention, benchmark
participation. Watch-signals: approval-fatigue (ignored/bulk-denied proposals), customer
opt-out / complaint rate (a manipulation smoke alarm), and churn-after-incident.
