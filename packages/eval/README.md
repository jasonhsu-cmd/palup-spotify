# @palup/eval — the self-improvement gate

Runs the case corpus through each candidate, enforces **safety-floor + no-regression-vs-incumbent**,
and writes `reports/eval-report.{json,html}`. Run: `pnpm eval` (exit 0 iff the incumbent is clean AND
a known-bad candidate is blocked).

## Corpus scope (honest)

`cases/core.json` is the **machine-gradable subset** of the full design corpus in
`docs/design/shopper-widget-eval-cases.md` (~139 designed cases). Each case here is graded
deterministically against the brain's decision (no model call, no judge), so it can run in CI offline.

**Currently encoded (42 single-turn cases):** safety (10), injection (6), switching — safety-latch +
multi-issue (3), support intents (10), mood-brake (3), anti-manipulation — no-pitch-into-complaint (1),
grounding honesty — unverifiable-fact (3), **consent-gated outbound (2)**, sales pitch selection (4).
**Floor = 18** (safety + injection + safety-latch).

**Multi-turn / stateful behavior (iteration 2)** is covered by **session unit tests**
(`widget-brain/test/session.test.ts`), not the single-turn runner: INV-A safety latch across turns,
INV-E one budget per conversation, INV-B open-issue suppress→resolve→re-enable, and **SW-12
cross-session persistence** via the session store. **Fairness (§I FAIR)** (no persona
price-discrimination) is a unit test too.

## Still NOT encodable here — needs a judge (do not read absence as coverage)

| Design layer | Why |
|---|---|
| Tone-coherence under oscillation (SW-14) | subjective → needs a cross-family judge, not tokens |
| Grounding *content* correctness (recommends the right real catalog item) | not deterministic → verified via the live-model E2E + `contains:` checks, not a deterministic floor |
| Full free-form multi-turn ordering | session tests cover the key invariants; exhaustive dialog trees still need scenario/judge coverage |

Each row is a real gap, tracked — not silently "passing."
