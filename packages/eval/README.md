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

## Judge-graded layers — `pnpm eval:judge` (iteration 3)

The two non-deterministic layers are now graded by a **cross-family judge** (`cases/subjective.json`,
`src/judge-run.ts`): **tone-coherence** (TC-1) and **grounding-content correctness** (GC-1, judged
against the authoritative catalog as ground truth). The agent runs on real Gemini; the judge must be a
DIFFERENT family (proposer≠evaluator, enforced by `crossFamilyGuard`).

- **Default (`pnpm eval:judge`):** a same-family **Gemini** judge — **ADVISORY only** (the guard refuses
  to gate it). Verified live: GC-1 ✅ TC-1 ✅.
- **True cross-family (`JUDGE_FAMILY=anthropic pnpm eval:judge`):** Claude on Vertex — **gates**. The
  adapter + auth are verified, but requires **enabling a Claude model in your project's Model Garden**
  (not enabled in the demo project). Set `JUDGE_MODEL` / `ANTHROPIC_VERTEX_REGION` to an enabled id.
- Requires GCP creds (the agent uses the real model); not part of the offline CI gate.

## Still needs work (tracked)

| Layer | Status |
|---|---|
| Cross-family gating live | mechanism built + advisory verified; **gating** unverified until Claude is enabled in Model Garden |
| Full free-form multi-turn dialog trees | session tests + TC-1 cover the key invariants; exhaustive trees still need broader scenario coverage |

Each row is a real gap, tracked — not silently "passing."
