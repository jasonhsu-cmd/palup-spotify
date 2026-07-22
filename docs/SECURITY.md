# Security & Enterprise Readiness

PalUp must satisfy enterprise security expectations. For an **autonomous agentic** product
that acts on merchant revenue, reads customer data, sits on a third-party platform, and
self-improves, that bar is a **superset** of standard SaaS security: everything a normal SOC
2 review asks for, **plus** a class of agentic threats that standard checklists barely
cover. This document backs the console's "Reliability & security" and "Agent governance"
sections and the `security-reviewer` subagent.

> **Framing:** certifications and trust are **organizational commitments operated over
> time**, not code. This doc is a roadmap with owners, not a switch to flip.

## 1. Key insight — governance and security converge

The controls built for agent governance double as the core security controls. Position this
in enterprise reviews:

| Governance control (already in the design) | Security role it plays |
|---|---|
| HITL boundary (`docs/HITL-POLICY.md`) | A hijacked or confused agent still cannot move money/data autonomously |
| Least-privilege, scoped, revocable tools | Contains tool abuse and lateral movement |
| Kill switch (merchant / agent-type / global) | Ultimate incident-response control |
| Evolution pipeline + eval gate + auto-rollback | Defense against poisoned / regressed models — *if the eval gate includes security evals* |
| Immutable audit log | Tamper-evident forensic trail |
| Ports & adapters (`docs/adr/0001`) | Isolates provider blast radius; enables data-residency and CMEK controls per adapter |

## 2. Agentic-specific threats (the differentiated part — most important)

Map to **OWASP Top 10 for LLM Applications**, **NIST AI RMF**, and **MITRE ATLAS**.

1. **Prompt injection / untrusted input (top risk).** Customer chat/email, product data, and
   web content are **untrusted**. They must never be able to escalate the agent's actions.
   Mitigations: treat all external content as untrusted data (not instructions); constrain
   tools so injected instructions cannot trigger a boundary-crossing action without HITL;
   output/egress filtering; allow-listed action targets.
2. **Cross-tenant isolation (catastrophic if breached).** Per-merchant isolation of agent
   memory, context, credentials, tools, and data. No shared mutable state that can leak
   across tenants. This is the single most tested control in a multi-tenant review — enforce
   in code and in tests (`test-engineer`) and block on any cross-tenant path
   (`security-reviewer`).
3. **Excessive agency / confused deputy.** Scoped intent, least-privilege tools, HITL for
   boundary actions, kill switch. An agent can never grant itself more scope.
4. **Data exfiltration via agent outputs/tools.** Egress controls, DLP/redaction on outbound
   comms, allow-listed recipients/domains, no bulk-export tool without HITL.
5. **Memory poisoning.** Validate and attribute memory writes; treat memory as security-
   sensitive; detect anomalous memory-driven behavior.
6. **Model supply chain.** Provenance for models/variants; the evolution pipeline gates all
   changes; **security evals are part of the blocking eval gate**; no self-hosted variant
   ships without passing.
7. **Sensitive data to LLMs.** Minimize and redact PII before inference; contractually
   ensure the model provider does not train on PalUp data; document in the sub-processor
   list.
8. **Third-party MCP / connector risk.** Any external MCP app or connector is a supply-chain
   and exfiltration surface — vet, scope, and never let it acquire autonomy that bypasses
   HITL (consistent with the OSS-vetting stance in `docs/ARCHITECTURE.md` §4.5).

## 3. Standard control domains (table stakes)

**Data protection.** TLS 1.2+/1.3 in transit; encryption at rest with KMS-managed keys
(envelope encryption), CMEK/BYOK available for enterprise; data classification; PII
minimization; retention + right-to-erasure; **frictionless export** stays free
(`docs/STICKINESS.md`) — deletion and portability are security *and* trust features.

**Data residency.** US at launch; the ports/adapters design (ADR-0001) is what makes
regional residency (EU, etc.) additive rather than a rewrite. Required for enterprise +
GDPR.

**Identity & access.** SSO (SAML/OIDC), SCIM provisioning, enforced MFA, RBAC (the console's
role-scoped nav / "Users & roles"), least privilege, just-in-time privileged access,
break-glass with audit.

**Secrets.** Via the secrets port only — never in code, prompts, logs, or fixtures; KMS /
Secret Manager; automatic rotation; short-lived credentials for agents.

**Infrastructure.** Private networking / VPC-SC, egress controls, WAF; container/image
scanning (GKE); hardened baselines; IaC with policy checks.

**AppSec & supply chain.** SAST/DAST, dependency & **license scanning against the allowlist policy in
`docs/design/oss-and-licensing.md`** (build fails on any copyleft/source-available/proprietary/unknown
license without recorded legal sign-off), **SBOM**, pinned deps,
signed artifacts; secure SDLC via the gated build pipeline (`security-reviewer` required on
sensitive changes); annual + on-major-change **pen testing** and a **bug bounty**.

**Logging & monitoring.** Immutable, tamper-evident audit log of every autonomous action;
centralized logging with PII controls; **SIEM integration**; the console's Security/SOC and
Event Center as the operator surface.

**Resilience.** Backups with tested restores; documented RTO/RPO; BC/DR; progressive,
gated, reversible deploys (`release-manager`).

## 4. Detection & response

- Documented incident-response plan and security runbooks; breach-notification process
  meeting regulatory timelines.
- Autonomous security self-healing (isolate, rotate short-lived creds, block) is
  **auto-allowed then alert**; anything that would change cost or the business model becomes
  an Approval Center proposal (`docs/HITL-POLICY.md`). Security containment must never itself
  become an ungoverned action.
- The **kill switch** is the top-level containment control at all three scopes.

## 5. Compliance roadmap (targets with owners, not switches)

| Framework | Why it matters for PalUp | Posture |
|---|---|---|
| **SOC 2 Type II** | The baseline enterprise SaaS ask | Primary near-term target; requires an operated control environment + audit window |
| **ISO 27001** | International / larger enterprise | Follow-on |
| **PCI DSS** | Commerce/payments adjacency | **Minimize scope** — rely on Shopify/PSP for card data; document that PalUp does not store PAN; confirm SAQ level |
| **GDPR / CCPA-CPRA** | Customer PII across regions | DPA + sub-processor list + residency + erasure/export from day one |
| **EU AI Act & AI governance** | Autonomous agents may be higher-risk in some uses | Track early; the governance/eval/audit stack is a head start |

## 6. Enterprise-buyer readiness

Stand up a **Trust Center** (certifications, sub-processors, architecture, data handling);
be ready for **SIG / CAIQ** security questionnaires; publish DPA and sub-processor list;
provide CMEK/BYOK, SSO/SCIM, audit-log export, and configurable data residency/retention as
the concrete features enterprise procurement checks for.

## 7. Bottom line

PalUp is unusually security-forward already, because its governance controls *are* security
controls — HITL, least privilege, kill switch, gated self-improvement, immutable audit. The
work to "satisfy enterprise security expectations" is threefold: (1) make the **agentic-
specific** threats — prompt injection and tenant isolation above all — first-class in code
and tests; (2) add the **standard control domains and certifications**, which are
organizational commitments operated over time; (3) make it **legible to buyers** via a trust
center and questionnaire readiness. Do these, and security becomes a moat and a sales
accelerant rather than a gate.
