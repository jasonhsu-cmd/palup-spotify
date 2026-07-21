---
description: Run the blocking evaluation suite for a run-time agent candidate (the quality gate).
argument-hint: <agent candidate id or path>
---
Run the eval gate for: **$ARGUMENTS**

Per `docs/AGENT-GOVERNANCE.md`, the eval gate is automatic and BLOCKING — "nothing ships
without passing." Evaluate the candidate on: task success, quality, safety, tone/brand, and
cost, against the recorded thresholds.

Report per-metric pass/fail and an overall verdict. If it passes, note that a HUMAN approval
in the Approval Center is still required before promotion. If it fails, keep the candidate
in canary/frozen and summarize what regressed. Never mark a candidate promotable on a
failing or missing eval.
