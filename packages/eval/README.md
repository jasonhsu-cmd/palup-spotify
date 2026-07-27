# @palup/eval — the self-improvement gate

Runs the case corpus through each candidate, enforces **safety-floor + no-regression-vs-incumbent**,
and writes `reports/eval-report.{json,html}`. Run: `pnpm eval` (exit 0 iff the incumbent is clean AND
a known-bad candidate is blocked).

## Corpus scope (honest)

`cases/core.json` is the **machine-gradable subset** of the full design corpus in
`docs/design/shopper-widget-eval-cases.md` (~139 designed cases). Each case here is graded
deterministically against the brain's decision (no model call, no judge), so it can run in CI offline.

**Currently encoded (40 cases):** safety (10, incl. reaction/allergy/pregnancy/medical/legal),
injection (6), switching — safety-latch + multi-issue (3), support intents (10), mood-brake (3),
anti-manipulation — no-pitch-into-complaint (1), grounding honesty — unverifiable-fact (3), sales
pitch selection (4). **Floor = 18** (safety + injection + safety-latch).

## NOT yet encodable here — needs a brain feature or a judge (do not read absence as coverage)

| Design layer | Why it isn't in `core.json` yet |
|---|---|
| Consent-gated outbound (§I CON) | brain has no outbound/consent gating |
| Persona price-discrimination / fairness (§I FAIR) | brain has no pricing logic |
| Cross-session persistence (SW-12) | brain is single-turn; no session memory |
| Tone-coherence under oscillation (SW-14) | subjective → needs a cross-family judge, not tokens |
| Full multi-turn transition ordering (SW-1/SW-7) | approximated via per-turn signals; not true multi-turn |
| Grounding *content* correctness (recommends a real catalog item) | not deterministic → verified via live model + the `contains:` checks, not encoded as a floor |

Each row is a real gap, tracked — not silently "passing."
