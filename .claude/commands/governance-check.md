---
description: Verify a change respects the HITL boundary, portability, and evolution gates before merge.
argument-hint: <PR, branch, or file paths>
---
Audit the following for governance compliance before merge: **$ARGUMENTS**

Check against the non-negotiables in `CLAUDE.md` §3:
1. **HITL boundary** (`docs/HITL-POLICY.md`): every boundary-crossing agent action produces
   an Approval Center proposal (with a reversal plan) and is NOT auto-executed. Run the
   `hitl-approval-gate` checklist.
2. **Portability** (ADR-0001): no provider SDK outside `packages/platform-ports/*/adapters/`;
   no hard-coded region/model/endpoint in feature code. Run the `portability-guard` checks.
3. **Evolution gates** (`docs/AGENT-GOVERNANCE.md`): no run-time agent can self-promote or
   skip a stage; auto-rollback + freeze exist; human approval gates promotion.
4. **Kill switch** honored at all three scopes; long loops check halt signals.
5. **Audit**: every autonomous action is logged with actor, decision, and reversal path.
6. **Least privilege**: credentials scoped and revocable; no secrets in code/logs/prompts.

Output a pass/block verdict with specific findings (file/line), severity, and required fix.
Block on any violation.
