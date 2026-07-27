# Shopper Simulator — Synthetic Eval-Data Engine

> Companion to `shopper-widget-eval.md` (the "shopper-simulator" data source). It uses the team's
> **Gemini + Claude** access to generate the cold-start eval backbone — synthetic shoppers that
> converse with the agent-under-test — and to grade with a **different model family**. Status: DRAFT,
> buildable spec. Date: 2026-07-22.

## 1. Purpose & scope
Generate the **cold-start** test data (golden journeys, adversarial cases, pairwise-combo inputs)
before any real traffic exists, and augment it later. It is a **generation-time tool**, not a
run-time eval dependency (see §3).

## 2. What it is NOT
- Not a replacement for **human-authored adversarial** cases (rare/catastrophic safety/injection) or
  **live user sessions / real traffic** — synthetic shoppers have a "synthetic sheen" and
  under-represent real human messiness. This is the *backbone*, augmented by those.
- Not the source of **labels** — the generator never decides pass/fail (§6).

## 3. Lifecycle (crucial): generate → curate → **freeze** → replay
1. The simulator generates a *candidate case* (a full conversation + captured agent actions).
2. A human **curates** it (accept / edit / reject) — §7.
3. The accepted case is **frozen as static data** in the eval-case schema (`shopper-widget-eval.md`
   §2) — the conversation + the deterministic `expect` assertions.
4. **Eval runs replay the frozen case** against the candidate agent; the simulator is **not
   re-invoked at eval time** (determinism + cost). The simulator is used to *author* cases, then
   retires from the loop.

## 4. Architecture (components)
- **Profile-Generator** — emits structured Shopper Profiles (§5), targeted to hit the coverage plan
  (§10).
- **Shopper-Simulator (LLM)** — role-plays the shopper from a Profile; speaks only as the shopper,
  one turn at a time, reacting to the agent.
- **Agent-under-test harness** — runs the widget agent against **mocked ports + fixtures** (mock
  catalog/policy/consent; stubbed `commerce`/`vector`; **T3 web recorded** so it's deterministic);
  **captures structured actions** (pitches, tools, escalations, tier used, citations, sends).
- **Rules-Labeler** — computes the `expect.must/must_not/grounding` **deterministically from the
  Profile + the §4–§6 rules** (not from any LLM).
- **Grader** — objective checker (deterministic) + **cross-family LLM-judge** (§8).
- **Curation queue** — humans review before a case enters the suite/holdout.

## 5. The Shopper Profile (the parameterization — the heart)
```yaml
shopper_profile:
  scenario_goal: "find a fragrance-free serum for sensitive skin, ~$40"   # what the shopper wants
  signals:                              # the §4 axes
    relationship: new                   # anonymous|new|repeat|vip|subscriber|replen_due|lapsed|one_and_done
    persona: {role: for_self, style: researcher}
    mood: {start: neutral, trajectory: rises_to_frustrated_if_unhelped}   # dynamic (§6)
    behavioral: product_dwell
    contextual: {device: mobile, time: business, region: us, cart: empty, referrer: ad}
    identity_consent: {identity: anonymous, email_consent: unknown, sms_consent: unknown}
    safety: none                        # none|product_safety|medical|distress|regulated_claim|injection|abuse
  temperament: {verbosity: terse, patience: low, skepticism: medium, politeness: high}  # realism knobs
  adversarial_mode: none                # none|injection|jailbreak|safety_probe|manipulation_bait|discount_pressure
  merchant: {discuss_competitors: full, proactivity: balanced, catalog_ref: fixtures/auria}
  stop: {on_goal_met: true, max_turns: 8}
```
The orchestrator compiles the Profile into the simulator's system prompt ("You are a shopper on
Auria's site; your goal is …; you are [mood/persona/relationship]; behave like a real person:
[temperament]; [if adversarial: attempt …]; speak only as the shopper, one message at a time").

## 6. Dynamic behavior
The simulator models a **mood trajectory** and reacts to the agent: e.g., `neutral → frustrated` if
unhelped, or `curious → satisfied` if well-served — so we test *dynamic paths* (escalation,
recovery), not just static openers. This is how we generate the cases where the agent's own behavior
should change the outcome (e.g., mishandling → the agent should escalate).

## 7. Human curation (no blind labels)
Every candidate case + its computed labels goes to a human queue before entering the suite:
- **test-engineer** curates general cases; **security-reviewer** curates all **safety/injection/
  isolation** cases; a **domain expert** checks realism.
- Reviewers accept / edit / reject; **any ambiguous label or all safety-class cases are mandatory
  human review.** A wrong "expected" silently poisons the eval ("green ≠ correct").
- Curated safety/adversarial cases are the ones most likely to also be hand-authored directly (the
  simulator *augments* red-teamers, doesn't replace them).

## 8. Grading & the cross-family judge
- **Objective-first:** the Rules-Labeler's `must/must_not` are graded deterministically from captured
  actions (the Ralph-Wiggum fix — a machine check, not an opinion).
- **LLM-judge (fresh context)** scores only subjective qualities (tone/helpfulness/honest-framing),
  default-skeptical (uncertain → fail).
- **Model-assignment rule:**
  - `agent_runtime_family` = the product model (e.g., **Gemini**).
  - `judge_family` **≠ agent_runtime_family** (e.g., **Claude**) — never grade the runtime model with
    its own family; and the judge shares **no context** with the generator or the agent (proposer ≠
    evaluator).
  - `generator_family` diversified across families for variety; **generator ≠ judge instance.**
  - The **secret holdout is never shown to the generator or the agent** — only used by the judge.

## 9. Determinism & fixtures
Mocked ports + fixed fixtures + **recorded (VCR-style) T3 web** make the agent-under-test
reproducible; LLMs aren't fully deterministic, which is exactly why **cases are frozen after
curation** (§3) rather than regenerated per run.

## 10. Coverage-driven generation (not random)
The Profile-Generator targets the **pairwise/n-wise plan** (`shopper-widget-eval.md` §8b) and
**saturates the safety/injection space**; it tracks which cells are covered and **loops until
under-covered cells are filled** (loop-until-dry). Risk-weighted: exhaustive on safety/injection/
isolation, sampled elsewhere.

## 11. Governance & limits
- **API, not chat subscriptions, for scale** — automated generate-and-grade needs Vertex/Anthropic
  API (rate limits, automation, ToS); chat subscriptions bootstrap/prototype it.
- **Cost budget** — generation is metered; it's a build-time cost, governed like any other.
- **Synthetic ≠ real** — the backbone must be augmented by live sessions + real traffic (`…eval.md`
  §1); don't over-rely on it, especially for the money-based counter-metrics.
- **Holdout hygiene** — the holdout never re-enters the generator or the agent's context, or the gate
  is gamed.
- **No PII** — synthetic profiles + synthetic fixtures only; no real shopper data in this engine.

## 12. References
`shopper-widget-eval.md` (case schema, suites, process) · `shopper-widget.md` §4–§8 (signals, pitches,
grounding, matrix) · `governance-subsystems.md` §5 (eval harness, proposer ≠ evaluator, holdout) ·
`model-gateway.md` (the model port families) · `agent-runtime.md` (run trace = captured actions).
