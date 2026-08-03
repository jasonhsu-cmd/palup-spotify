# @palup/eval — the self-improvement gate

Runs the case corpus through each candidate, enforces **safety-floor + no-regression-vs-incumbent**,
and writes `reports/eval-report.{json,html}`. Run: `pnpm eval` (exit 0 iff the incumbent is clean AND
a known-bad candidate is blocked).

## Corpus scope (honest)

`cases/core.json` is the **machine-gradable subset** of the full design corpus in
`docs/design/shopper-widget-eval-cases.md` (~139 designed cases). Each case here is graded
deterministically against the brain's decision (no model call, no judge), so it can run in CI offline.

**Currently encoded (46 single-turn cases):** safety (10), injection (6), switching — safety-latch +
multi-issue (3), support intents (10), mood-brake (3), anti-manipulation — no-pitch-into-complaint (1),
grounding honesty — unverifiable-fact (3), **consent-gated outbound (2)**, sales pitch selection (4),
**persona price-invariance (2)**, **persona/memory leak (2)**.
**Floor = 22** (safety + injection + safety-latch + fairness + leak) — `floor: true` in the corpus,
collected by `FLOOR_CASES` (`src/floor.ts`). `test/gate.test.ts` asserts `>= 18` so the count can grow
without the test going stale; the assertion is a vacuity guard, not the current total.

**Multi-turn / stateful behavior (iteration 2)** is covered by **session unit tests**
(`widget-brain/test/session.test.ts`), not the single-turn runner: INV-A safety latch across turns,
INV-E one budget per conversation, INV-B open-issue suppress→resolve→re-enable, and **SW-12
cross-session persistence** via the session store. **Fairness (§I FAIR)** (no persona
price-discrimination) also has unit-test coverage, but it is no longer *only* a unit test — FAIR-1/2
and LEAK-1/2 are floor cases in this corpus and gate `pnpm eval` deterministically.

## Judge-graded layers — `pnpm eval:judge` (iteration 3)

The two non-deterministic layers are now graded by a **cross-family judge** (`cases/subjective.json`,
`src/judge-run.ts`): **tone-coherence** (TC-1) and **grounding-content correctness** (GC-1, judged
against the authoritative catalog as ground truth). The agent runs on real Gemini; the judge must be a
DIFFERENT family (proposer≠evaluator, enforced by `crossFamilyGuard`).

- **Default (`pnpm eval:judge`):** a same-family **Gemini** judge — **ADVISORY only** (the guard refuses
  to gate it). Verified live: GC-1 ✅ TC-1 ✅.
- **True cross-family (`JUDGE_FAMILY=anthropic pnpm eval:judge`):** a **Claude** judge — **gates**.
  There are two ways to reach Claude; the runner (`src/judge-run.ts`) auto-prefers whichever is
  configured:
  - **Direct Anthropic API (recommended — just a key):** set `ANTHROPIC_API_KEY`. **No GCP / Model
    Garden needed for the judge.** Model defaults to `claude-opus-4-8`; override with `ANTHROPIC_MODEL`.
  - **Claude on Vertex (fallback — used only when `ANTHROPIC_API_KEY` is absent):** needs a Claude
    model **enabled in your project's Model Garden**. Set `ANTHROPIC_VERTEX_REGION` (default `us-east5`)
    / `JUDGE_MODEL` (default `claude-sonnet-4-5@20250929`) to an enabled id.
- **You still need GCP creds either way** (`GOOGLE_CLOUD_PROJECT` + ADC): the *agent being judged* runs
  on real Gemini, so the harness exits if Vertex isn't configured. `ANTHROPIC_API_KEY` replaces Model
  Garden only for the **judge**, not the whole harness. Not part of the offline CI gate.
- **Honesty:** both Claude adapters (`anthropic-api.ts`, `anthropic-vertex.ts`) are marked
  `⚠️ UNVERIFIED-LIVE` — wired but never run against a real key / Model-Garden access. Treat the first
  `JUDGE_FAMILY=anthropic` run as the actual verification.

## Still needs work (tracked)

| Layer | Status |
|---|---|
| Cross-family gating live | mechanism built + advisory verified; **gating** unverified live — both Claude judges (direct-API via `ANTHROPIC_API_KEY`, and Claude-on-Vertex via Model Garden) are wired but `⚠️ UNVERIFIED-LIVE` until run against a real key / access |
| Full free-form multi-turn dialog trees | session tests + TC-1 cover the key invariants; exhaustive trees still need broader scenario coverage |

Each row is a real gap, tracked — not silently "passing."
