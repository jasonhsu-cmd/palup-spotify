# ADR-0003: Governed self-improvement pipeline (gated, HITL, reversible)

- **Status:** Accepted
- **Context:** The product should self-improve (inspired by Hermes/OpenClaw) but must avoid
  OpenClaw's stated failure: evolution with no governance and no human-in-the-loop. Agents
  handle merchant revenue and PalUp margin, so an unsupervised bad change is unacceptable.

## Decision
Every run-time agent change follows one mandatory, ordered pipeline:
`propose → shadow(0%) → canary(1–5%) → eval gate(auto, blocking) → human approve → promote → monitor`,
with **automatic rollback + freeze** on any regression at a live stage, and a three-scope
**kill switch** (merchant / agent-type / global) that always overrides. Self-improvement is
allowed; self-deployment is prohibited. Details: `docs/AGENT-GOVERNANCE.md`.

## Alternatives considered
- **Fully autonomous evolution (OpenClaw-style).** Fastest improvement; no containment.
  Rejected — it is the exact anti-pattern we exist to fix.
- **Manual-only changes (no self-improvement).** Safest; forfeits the product's core value
  and the Hermes-style advantage. Rejected.
- **Gates but auto-promote when evals pass (skip the human).** Tempting for velocity; but a
  passing eval is necessary, not sufficient, for money/model/business-model changes.
  Rejected — human approval stays mandatory for behavior changes and boundary crossings.

## Consequences
- (+) Continuous improvement with a hard safety floor and full auditability.
- (+) A bad change is contained (canary blast radius) and self-reverts.
- (−) Promotion latency: good changes wait for a human. Accepted; mitigated by making
  shadow/canary/eval automatic so the human sees a ready-to-decide package.
- (−) The eval suite becomes safety-critical infrastructure and must itself be maintained
  and reviewed.
