# Design Spec — Integration Architecture

_Every external system is reached through a platform port (ADR-0001); provider SDKs live only in
adapters. Backs the merchant **Settings → Integrations** and admin **FinOps cost stack /
Engineering Monitor** which name the concrete vendors. ~15 integrations across 5 ports._

## 1. Shopify — the anchor (behind `commerce`)

- **OAuth install** stitches prospect → merchant on `shop.domain + owner email`, carrying the signup
  conversation/goal into the new account (admin "recently converted" flow). Tokens via `secrets`.
- **Webhook ingestion at scale** (millions of stores): `orders/create`, `carts/update`,
  `customers/*`, `app/uninstalled`, etc. → `commerce.verifyWebhook` → **published to the event bus**
  (ADR-0006), never processed synchronously on the HTTP path. Idempotent (dedup on Shopify event id);
  retries tolerated. **`app/uninstalled` triggers immediate `secrets` revocation/rotation of that
  shop's token** (least-privilege / revocable) and halts the tenant's agent triggers.
- **Rate limits & bulk:** respect Shopify's per-shop API limits with per-tenant backoff (Event
  Center shows "Shopify rate-limit backoff"); initial import uses the Bulk Operations API. Shopify
  stays **system of record**; PalUp mirrors read-optimized copies (data-model spec).
- **Billing:** `commerce.createBillingCharge` (PalUp never holds money — attribution/billing spec).
- **Portability:** a second commerce platform is a new `commerce` adapter, same runtime (moat
  defense, `docs/MOAT.md`).

## 2. Comms — email / SMS / chat (behind `comms`)

- **Email:** SendGrid / Amazon SES. Domain auth (SPF/DKIM/DMARC) per merchant. CAN-SPAM enforced
  (physical address, one-click unsubscribe, sender identity).
- **SMS:** Twilio, **A2P 10DLC registered**; TCPA enforced (consent required, quiet hours, frequency
  caps); consent-missing recipients excluded (merchant shows 412 excluded).
- **Chat:** live-chat widget (`cdn.palup.ai/w.js`) ↔ WebSocket take-over (ADR-0006).
- **Every send is consent-gated + DLP-redacted + policy-checked** at the port boundary; a send that
  fails consent/quiet-hours/frequency is rejected, not queued. Boundary-crossing sends (outside
  approved templates/frequency, new channels) route to HITL.

## 3. Model & media (behind `model`)

- **LLM:** Vertex AI Gemini 2.5 Flash (routine ~95%) / Pro (high-stakes ~4%) / self-trained
  Gemma/Llama canary (~1%); **Claude via Vertex Model Garden** as fallback (<1%). Embeddings
  (text-embedding-005) + Cohere Rerank behind `model`/`vector`.
- **Media generation:** Imagen 4 / Veo 3 / Adobe Firefly (image/video), ElevenLabs (voice) — metered
  by the credit model; generated creative passes the **media eval gate** (brand, safety, IP/
  copyright, claims, CAN-SPAM, AI-labeled, accessibility) before an approval can be granted.
- Provider substitution is an adapter/config change; keep ≥1 alternative viable in practice
  (`docs/MOAT.md` §4).

## 4. Ads, social, shipping, analytics (behind `commerce`/`comms`/dedicated adapters)

- **Ads:** Meta, Google (incl. PMax), TikTok, LinkedIn — spend is **always** an Approval Center item
  (ad budget = money boundary); connection is an authority change (two-person).
- **Social publishing:** Ayrshare. **Shipping:** ShipStation. **Analytics:** GA4, Klaviyo.
- **Prospect data (PalUp plane):** Clearbit / Apollo for ICP enrichment.
- Each connector is **allowlisted in Policy** (connector allowlist, per-connector spend cap) and
  vetted per `docs/SECURITY.md` §2.8; a connector never acquires autonomy that bypasses HITL.

## 5. Infra & security services

- **WAF/CDN:** Cloudflare. **Secrets/KMS:** Secret Manager (via `secrets`, CMEK/BYOK for
  enterprise). **Observability:** Grafana + OpenTelemetry + Sentry (via `telemetry`).
- **Identity:** SSO (SAML/OIDC), SCIM provisioning, passkey/hardware-key MFA + step-up (admin login).

## 6. Cross-cutting integration rules

1. All external I/O is async off the event bus where possible; the request path never blocks on a
   third party. 2. Every integration is tenant-scoped and residency-aware. 3. Webhooks/callbacks are
   idempotent and signature-verified. 4. Untrusted inbound content (chat, email, product data,
   webhooks) is **data, never instructions** (security spec). 5. Vendor specifics never leak past the
   adapter (ADR-0001; `portability-guard`).
