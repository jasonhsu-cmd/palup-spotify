# ADR-0002: Separate build-time and run-time agent planes; one shared run-time runtime

- **Status:** Accepted
- **Context:** "Agent" means two very different things here: the Claude Code subagents that
  *build* PalUp, and the product agents that *run* in production serving merchants and
  customers. There are also three run-time agent kinds (merchant partner, PalUp partner,
  self-healing monitors). Governing these inconsistently is the largest project risk.

## Decision
1. **Hard-separate build-time and run-time planes.** Build-time agents never touch
   production; they open PRs that humans merge. Run-time agents never modify their own code
   in production; they change only through the governed evolution pipeline.
2. **One shared Agent Runtime** hosts all three run-time agent kinds. An agent is a
   declarative bundle: `role + policy + tools + memory + model-tier`. Governance, audit,
   kill-switch, and evolution are implemented once in the runtime and inherited by every
   agent.

## Alternatives considered
- **One codebase for both planes / blur them.** Simplest mentally; catastrophic for
  governance — a build agent could self-deploy. Rejected outright.
- **Three separate runtimes for the three run-time agent kinds.** More isolation; triples
  the governance/audit/kill-switch implementation and drifts over time. Rejected.

## Consequences
- (+) Governance lives in exactly one place and every agent gets it for free.
- (+) New agent types (new industry, new business model) are config, not new infra —
  directly serves the expansion requirement.
- (+) The build/run separation makes "self-improving 24/7" safe by construction.
- (−) The shared runtime is a critical component; it needs strong tests, strict policy
  isolation between tenants/agents, and careful blast-radius control.
