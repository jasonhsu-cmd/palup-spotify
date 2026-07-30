---
description: Run the standard test-first (ATDD) → build → secure → release flow for a change, with all gates enforced.
argument-hint: <short description of the change>
---
Orchestrate shipping this change end-to-end: **$ARGUMENTS**

Follow the build-time workflow in `CLAUDE.md` §4 and delegate to subagents:
1. `solution-architect` — design note + task list with an explicit acceptance criterion per
   item; identify agent plane, HITL boundary, and portability impact up front.
2. `test-engineer` — **write the failing unit + E2E tests first** from those criteria (test-first/
   ATDD); building starts only once every criterion is covered by a red test.
3. `backend-builder` / `frontend-builder` — implement (parallelize independent tasks) **until the
   tests go green**; a red governance or port-contract test still blocks.
4. `security-reviewer` — required if this touches auth, secrets, payments, data, autonomy,
   or a governance surface.
5. If this changes RUN-TIME agent behavior: `agent-evolution-steward` must pass, and the
   change must enter the evolution pipeline (no direct-to-prod).
6. `release-manager` — progressive, flag-gated delivery with a ready rollback.

Do not skip a gate for speed. If any step reveals a money/model/business-model boundary
crossing, route it to a human via the Approval Center rather than working around it. Report
a checklist of which gates passed.
