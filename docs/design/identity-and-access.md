# Design Spec — Identity & Access Management (authN + authZ)

_The buildable identity & access service. RBAC policy fundamentals are set (`security-data-path.md`
§6, `governance-subsystems.md` §3, `data-model-and-tenancy.md`); the merchant-auth model is ADR-0011.
This spec adds the authN service, the authZ decision model, SSO/SCIM, passkey/step-up, API keys,
agent-credential issuance, break-glass, and account lifecycle — so auth/authz is **fully** planned.
Everything sits behind an **`identity` port** (added to the port list). Backs merchant **Settings →
Team/Security** and admin **Login / Users & Roles / Settings → Security**._

**Prime invariants:** authorization is decided **server-side at a single decision point** (never the
client); default-deny; every session/role/permission read is strong-consistency and **revocation
fails closed** (`data-platform.md` §1); every auth event is audited; no principal can escalate its own
privileges.

## 1. Authentication (who)

- **Merchant (primary): Shopify-embedded** (ADR-0011). App Bridge → short-lived Shopify session token
  → **token exchange** for a PalUp session bound to `{merchantId, userId, role}`. The embedded adapter
  **cryptographically validates the incoming Shopify session JWT** — signature (app secret),
  `aud` = app API key, `exp`/`nbf`, and `dest`/`iss` host — before exchange, and **derives
  `merchantId` from the verified token claims (`dest`/`sub`), never from any client-supplied value**
  (symmetric with the SSO assertion-validation in §3; a required `identity` contract test). The
  exchange is **single-use / short-TTL** (replay-resistant), and the embedded console sets **CSP
  `frame-ancestors`** to the Shopify-admin origin only (anti-clickjacking).
- **Merchant (secondary) + Admin/operators: standalone/SSO.** Email + **passkey/WebAuthn** (phishing-
  resistant MFA) or **SSO (SAML/OIDC)**; operators are **100% passkey/hardware-key**.
- **Sessions:** short-lived access token (opaque, server-validated) + rotating refresh with
  **refresh-reuse detection** (a rotated-then-replayed refresh token revokes the whole session
  family). A **session store** enables **immediate revocation, "sign-out-all", and per-device session
  management** (admin Settings "revoke session / sign-out-all"); the store is **tenant-scoped** (no
  cross-tenant session-id confusion) and **fails closed on unavailability** (unknown → deny, mirroring
  the kill-switch, `agent-runtime.md` §6). Session fixation prevented (new session id on auth); idle +
  absolute timeout (admin session-timeout setting).
- **Step-up:** sensitive actions (approvals above threshold, policy edits, kill-switch, authority/
  money-tool grants, bulk PII export) require a **fresh step-up** (re-assert passkey); step-up yields a
  short-TTL elevated `authLevel` on the session, scoped to the action class. Which actions require
  step-up is **policy-driven**, not hard-coded.

## 2. Authorization (what) — the decision point

- **Model: RBAC + tenant-scoped ABAC.** A single **policy decision point (PDP)** evaluates every
  request against: `role` permissions (5 merchant / 8 admin roles), **tenant scope** (`merchantId` /
  `org`), resource attributes, and `authLevel` (step-up). **Default-deny**; the API never returns or
  mutates what the principal's role+scope disallows.
- **Permission → operation mapping:** each API operation (`console-api-contracts.md`) declares the
  permission + scope + step-up it requires; the PDP enforces it uniformly (console, ask-bar, and
  internal callers). The **ask-bar inherits the same PDP** — it cannot surface what the role can't
  open, and a read never becomes a write.
- **Composition of controls:** `can-approve` (role attribute) + **two-person** (approver ≠ initiator,
  both authenticated + stepped-up) + **step-up** compose in the PDP for authority/security/pricing/
  model actions (`governance-subsystems.md` §3). Two-person is enforced as two distinct authenticated
  principals, not two clicks.
- **Reads are strong-consistency for authz** (RBAC/policy/revocation from primary; `data-platform.md`
  §1) so a revoked role or tightened policy takes effect immediately.

## 3. SSO / SCIM (enterprise)

- **SSO:** SAML 2.0 + OIDC, SP- and IdP-initiated; per-org IdP config (Entra, Okta, etc.); assertion
  signature + audience validation; JIT provisioning on first login.
- **SCIM 2.0:** automated provisioning **and deprovisioning** — a user disabled in the IdP is
  **auto-disabled in PalUp** (sessions revoked). **Group → role mapping** per org; multiple IdPs per
  org supported. **Mapping has a ceiling:** SSO/SCIM JIT can auto-grant only **non-privileged** roles;
  it **cannot auto-grant operator / Super-Admin / any `can-approve` or authority role** — those
  require explicit human assignment + step-up. This bounds a misconfigured or compromised IdP from
  injecting a high-privilege group.

## 4. Passkey / step-up enrollment

- **Enrollment:** new operators are **read-only until a passkey/hardware key is enrolled** (admin
  RBAC screen); merchants may enroll passkey or fall back to TOTP 2FA.
- **Recovery preserves the factor's strength.** Merchant recovery: second factor + audited admin
  reset. **Operator recovery never downgrades to TOTP/OTP** (operators are 100% phishing-resistant) —
  it requires a **second enrolled hardware key or a two-person admin reset**, never a silent bypass.
- **Break-glass / JIT privileged access:** time-boxed elevation for emergencies, **two-person +
  step-up + heavily audited**, auto-expiring — the only path to standing-privilege beyond normal RBAC
  (`docs/SECURITY.md`).

## 5. API keys (programmatic access)

- Scoped to a tenant + a permission subset; **shown once**, hashed at rest; **rotatable and instantly
  revocable**; used only for programmatic paths (never a user session); every key action attributed +
  audited. Keys cannot perform step-up-required actions.
- **Key scope is evaluated at use as `min(key_scope, current grantor scope)`** — if the granting user
  is **downgraded** (e.g. Owner→Viewer), the key's effective scope shrinks with them (and a role
  change re-scopes/revokes the grantor's keys). A key can never become standing privilege exceeding
  its now-reduced grantor. (Required contract test.)

## 6. Agent credentials (run-time authZ)

- Agents receive **scoped, short-lived, revocable credentials** via `secrets.issueScopedCredential`
  (runtime spec §5): least-privilege per declared tool, tenant-namespaced, auto-expiring. An agent
  **cannot escalate its own scope** (autonomy ceiling; non-self-mutable bundle, `agent-runtime.md` §1);
  money/PII tools require the allowlist + two-person grant. Revocation (kill-switch, offboard,
  incident) propagates immediately and fails closed.

## 7. Account lifecycle

`invite → enroll (passkey/2FA) → active → (role change, audited) → suspend → offboard/deprovision`.
Offboard revokes sessions + keys + agent grants and (SSO) is driven by SCIM. Every transition is
audited with actor + before→after (`governance-subsystems.md` §6).

## 8. `identity` port

```
authenticate(request): Principal{ merchantId|org, userId, role, authLevel, sessionId }
authorize(principal, operation, resourceCtx): allow|deny        // the PDP; default-deny
stepUp(principal, actionClass): elevatedPrincipal               // fresh passkey assertion, short TTL
revokeSession(sessionId | userId='all')                          // sign-out-all
issueApiKey / rotateApiKey / revokeApiKey(...)
```
Adapters: Shopify-embedded, SSO/SAML-OIDC, standalone. Contract tests: default-deny, tenant-scoping,
revocation-fails-closed, step-up required where declared, two-person distinctness, no privilege
escalation.

## 9. Invariants (tests — `security-reviewer`)

1. Authorization is server-side, default-deny, at one PDP; the client never decides. 2. Every RBAC/
policy/revocation read is strong-consistency; revocation (session, role, key, agent cred, SCIM
deprovision) takes effect immediately and fails closed. 3. Step-up is enforced for every declared
sensitive action; step-up tokens are short-TTL and action-scoped. 4. Two-person = two distinct
authenticated, stepped-up principals (approver ≠ initiator). 5. No principal (user, API key, or agent)
can exceed or escalate its granted scope; **API-key scope = min(key, current grantor) at use**.
6. Sessions resist fixation and refresh-replay; the session store is tenant-scoped and fail-closed;
sign-out-all works. 7. SCIM deprovision disables access everywhere; **SSO/SCIM JIT cannot auto-grant
privileged/authority roles**. 8. Every auth event is audited. **9. Embedded Shopify session tokens are
signature/audience/expiry-validated and tenant-bound from verified claims, never client input;
exchange is single-use and framing is CSP-restricted to Shopify.**
