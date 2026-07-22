# ADR-0011: Merchant authentication model — Shopify-embedded, portable behind an identity port

- **Status:** Accepted
- **Context:** The merchant console runs for a Shopify merchant. How merchant users authenticate is an
  architectural fork the design had not pinned: **embedded Shopify app** (App Bridge + session-token
  exchange, the standard for Shopify apps) vs. **standalone PalUp accounts** (email + 2FA / SSO). The
  mockup shows both flavors — a signed-in owner, 2FA-required, SSO/SAML for Enterprise, and API keys
  — so the answer must accommodate more than one path without coupling feature code to any single IdP.
  Portability (ADR-0001) and the future non-Shopify commerce platform (`docs/MOAT.md`) also argue
  against hard-wiring Shopify identity.

## Decision

1. **Primary merchant auth = Shopify-embedded.** The console runs embedded in Shopify admin via **App
   Bridge**; the browser gets a short-lived **Shopify session token**, which PalUp exchanges (token
   exchange) for a **PalUp session** scoped to that `merchant_id` + user + role. This is the lowest-
   friction, most-expected path for a Shopify app and inherits Shopify's own auth posture. The token
   is **cryptographically validated** (signature, `aud`, `exp`/`nbf`, `dest`/`iss`) and the tenant
   binds **from the verified claims, never client input**; the exchange is single-use and framing is
   CSP-restricted to Shopify admin (`identity-and-access.md` §1).
2. **Standalone + SSO is a supported secondary path** for: non-embedded/standalone console use, team
   members without Shopify staff accounts, and **Enterprise SSO (SAML/OIDC) + SCIM** — with 2FA/
   passkey required. Enterprise tenants map IdP groups → PalUp roles (`identity-and-access.md`).
3. **Everything sits behind an `identity` port.** Feature code depends on an authenticated
   `{merchantId, userId, role, authLevel}` principal, never on Shopify/App-Bridge/IdP specifics. The
   Shopify-embedded adapter and the SSO/standalone adapter both satisfy it; a second commerce
   platform is a new adapter, not a rewrite (ADR-0001).
4. **Role is PalUp's, not Shopify's.** Shopify identity proves *who*; PalUp's RBAC (5 merchant roles)
   decides *what* — mapped from Shopify staff role / invite / SSO group, and editable in PalUp with
   audit. PalUp never inherits Shopify permissions wholesale.
5. **API keys** are a separate programmatic-access path (scoped, shown-once, rotatable, revocable),
   not a user-session path (`identity-and-access.md`).

## Alternatives considered

- **Standalone accounts only (email + 2FA).** Full control, IdP-agnostic. Rejected as *primary* —
  it adds signup friction to a Shopify app whose whole GTM is low-friction install, and it ignores
  the session Shopify already provides. Kept as the secondary/SSO path.
- **Shopify-embedded only.** Simplest single path. Rejected as *sole* model — it strands non-embedded
  use, Enterprise SSO/SCIM, and (critically) the second-commerce-platform future; and it would couple
  identity to Shopify against ADR-0001.
- **Trust Shopify staff roles as PalUp permissions directly.** Rejected — PalUp's money/autonomy
  boundaries need their own RBAC + can-approve semantics; a Shopify "staff" role is not a PalUp
  authorization decision.

## Consequences

- (+) Lowest-friction default for the Shopify market, Enterprise-ready via SSO/SCIM, and portable —
  identity is an adapter behind a port.
- (+) PalUp owns the authorization decision (RBAC + two-person + step-up), decoupled from the IdP.
- (−) Two auth adapters (embedded + SSO/standalone) to build and keep behavior-equivalent; the
  `identity` port needs a contract test covering both.
- (−) Session-token exchange + role mapping add moving parts (specified in `identity-and-access.md`).
