# Design Spec — Security in the Data Path

_The code-level realization of `docs/SECURITY.md` for an autonomous agent that acts on merchant
revenue and reads customer data. Governance controls **are** security controls; this spec covers the
agentic-specific threats that standard checklists miss, plus the standard controls in the data path.
Backs the admin **Security/SOC**, **Event Center**, and **Policy** screens._

## 1. Prompt injection / untrusted input (top risk)

- **Content-as-data boundary:** customer chat/email, product data, web content, and webhook payloads
  are **untrusted data, never instructions.** The runtime separates instruction context from content
  context; injected text cannot widen tool scope or trigger a boundary action.
- **Semantic firewall** on money/PII tools (100% coverage in the UI): a classifier gates tool calls;
  injection/jailbreak/anomalous-tool-use/exfil attempts are blocked/quarantined and logged (admin
  shows 1,204 injections blocked/day, 0 succeeded). Output/egress filtering + allow-listed action
  targets.
- Structural backstop: even a fully hijacked agent **cannot** move money/data — the HITL gate and
  tool allowlist stop it (excessive-agency / confused-deputy defense).

## 2. Cross-tenant isolation (catastrophic if breached — the most-tested control)

- Row-level security scoped by `merchant_id`; tenant-namespaced memory/vectors/object storage;
  tenant-scoped, revocable agent credentials; **no shared mutable cross-tenant state.**
- `test-engineer` writes cross-tenant leakage tests; `security-reviewer` **blocks merge on any
  cross-tenant path.** Memory isolation is asserted 100% tenant-scoped (admin Evolution health).

## 3. Data exfiltration & DLP

- Egress controls + **DLP/PII redaction** on all outbound comms (`comms` boundary; the full ordered
  pre-send gate incl. deterministic SMS STOP/HELP and suppression is in
  `docs/design/comms-and-messaging.md`); allow-listed recipients/domains; **no bulk-export tool
  without HITL.**
- **Redaction before inference — enforced at the `model` port boundary.** PII minimization/redaction
  is the responsibility of the `model` adapter (and a guardrail step before `Act`/`generate` in the
  runtime), symmetric with the `comms` DLP boundary — feature/agent code cannot send raw PII to a
  provider by omission. It is an **invariant** (§10.4) and a **required `model` contract test**
  (`port-interfaces.md`), not a caller convention.
- **Human bulk PII export** (console export endpoints) is **step-up-required and audited**; **no
  run-time agent tool performs bulk export** at all (the agent invariant above).

## 4. Memory poisoning

- Memory writes are validated + attributed (provenance); memory is security-sensitive; anomalous
  memory-driven behavior is detectable and reviewable (runtime spec §7).

## 5. Model supply chain

- Provenance for models/variants; **all** changes gated by the evolution pipeline; **security evals
  are part of the blocking eval gate**; no self-hosted/canary variant ships without passing
  (governance spec §5).

## 6. Standard controls in the data path

- **Encryption:** TLS 1.2+/1.3 in transit; at-rest envelope encryption via KMS; **CMEK/BYOK** for
  enterprise (per-adapter, ADR-0001).
- **Identity/access:** SSO (SAML/OIDC), SCIM, passkey/hardware-key MFA, **step-up for sensitive
  actions**, RBAC (5 merchant / 8 admin roles), least privilege, break-glass audited. The console
  ask-bar inherits the RBAC matrix (reads never become actions; can't surface what the role can't
  open).
- **Secrets:** via `secrets` only — never in code/prompts/logs/fixtures; short-lived, rotated,
  revocable agent credentials.
- **Unbounded-consumption ceiling** (5× trip) + rate limits per tenant (email 2k/hr, SMS 200/hr) in
  Policy.
- **Audit:** append-only, hash-chained, 7-yr, tamper-evident (governance spec §6). **SIEM** feed.

## 7. Residency & data rights

- US at launch; **EU-per-tenant** residency via region-routed adapters (tenant-keyed layout makes
  this additive, ADR-0004). **CCPA/GDPR:** export (CSV/JSON), delete-a-customer / right-to-be-
  forgotten, configurable retention — all first-class and free (`docs/STICKINESS.md`). DPA +
  sub-processor list for enterprise.

## 8. Detection & response

- Autonomous security self-healing (isolate, rotate short-lived creds, block) is auto-allowed **then
  alert**; anything that would change cost/business-model becomes an Approval Center proposal (HITL
  §4). The **three-scope kill switch** is the top containment control. Incident-response plan +
  breach-notification process meet regulatory timelines.

## 9. Compliance roadmap (organizational, operated over time)

SOC 2 Type II (near-term), ISO 27001 (follow-on), PCI (minimized — no PAN stored), GDPR/CCPA (day
one), EU AI Act (tracked; the governance/eval/audit stack is a head start). Trust Center + SIG/CAIQ
readiness for enterprise buyers (`docs/SECURITY.md` §5–6).

## 10. Invariants (tests / `security-reviewer` sign-off)

1. No cross-tenant read/write path exists. 2. Untrusted content can never escalate tool scope or
cross a boundary without HITL. 3. No secret reaches a log/prompt. 4. PII is redacted before egress
and before inference. 5. No bulk export without HITL. 6. Step-up enforced on all sensitive actions.
7. Audit hash chain verifies; residency routing holds per tenant.
