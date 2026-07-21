# Design Spec — Advertising & Social Media Management

_The buildable service architecture for paid ads, organic social, creative/media, conversion
tracking, and SEO/AEO. Spend-governance fundamentals are set (`HITL-POLICY.md`; ad spend = money
boundary → Approval Center; connecting a platform = authority/two-person; per-connector caps in
`cost-margin-telemetry.md` §2 and Policy). This spec adds the services those depend on so
advertising/social is **fully** planned. No new ADR (fits ADR-0001 ports, ADR-0005 runtime, ADR-0006
eventing, ADR-0007 attribution). Backs merchant **Campaigns / Campaign Builder / Outreach** and admin
**Growth Campaigns / Site Experiments (CRO) / Growth Overview / Prospect Pipeline**._

**Prime invariants:** **no ad spend, budget change, or campaign launch executes without an approved
proposal** (or a rule strictly inside the GTM budget policy); **pacing can never exceed a policy
ceiling**; all generated creative passes the **media eval gate** before an approval can be granted;
conversion-tracking data is consent-gated and PII-minimized.

## 1. Ad-platform integration (behind `commerce`/dedicated ad adapters)

- **Adapters:** Meta Ads, Google Ads (incl. PMax), TikTok Ads, LinkedIn Ads — each behind an
  `ads` adapter surface (portable per ADR-0001), OAuth + token refresh via `secrets`, rate-limit
  aware, sandbox/live separated.
- **Normalized campaign object model** across platforms: `ad_campaign → ad_set/ad_group → ad`
  (+ `creative_ref`, `audience_ref`, `budget`, `status`), so agents and the console reason in one
  vocabulary and a new platform is a new adapter, not a new model.
- **Writes are governed, with an exact rule/HITL line:** **initial campaign launch and any
  spend-*increase* / budget-*raise* / ceiling change are ALWAYS Approval Center** (money boundary) —
  a rule can **never** originate a launch or raise a ceiling. Only **bounded, pre-approved recurring
  pacing *within* an already-approved campaign** may ride an Automation Rule. Pause/stop is
  auto-allowed (reversible, spend-reducing). Adding/connecting a platform is an **authority change
  (two-person)** and puts it on the connector allowlist (Policy).
- **Least-privilege ad tokens** via `secrets`: publish/manage-scoped, short-lived, revocable,
  per-tenant.

## 2. Performance-data ingestion & normalization

- Pull spend / impressions / clicks / conversions / **ROAS** per campaign per platform on a schedule
  + webhook where available → **normalized `ad_metric` rollups** (unified across platforms) feeding
  the channel-comparison table, ROAS/CAC KPIs, and the leak/heatmap diagnostics.
- Reconcile platform-reported conversions with PalUp's own **incrementality attribution** (ADR-0007)
  — platform ROAS is a *reported* number; the fee/value story uses the holdout-based measure.
  Divergence beyond a bound is surfaced, not silently trusted.
- **Invalid-traffic / click-fraud signal.** Holdout attribution shields the *fee basis* from inflated
  platform conversions, but fraudulent clicks still burn GTM budget — an **IVT/waste signal** feeds
  the leak diagnostics (beyond just the ROI floor), so wasted spend is visible and actionable.

## 3. Real-time budget pacing & enforcement engine

- **The ceiling is enforced by platform-native hard caps, not by polling.** At connect/launch, PalUp
  sets the ad platform's own **campaign/ad-set daily + lifetime budgets *and* an account-level spend
  cap** to the Policy ceiling — the platform stops spending even if PalUp is lagging or down. This is
  the enforcing backstop.
- **Poll-and-pause is the secondary control.** The engine additionally polls spend and auto-pauses as
  cap approaches ("budget-capped by early afternoon"); spend-reducing actions (pause/stop) are
  auto-allowed, **spend-increasing reallocation is a proposal.**
- Because platforms spend continuously, any residual **overshoot during poll lag / API stall /
  outage is reconciled as a cost-breaker event** (Event Center) and counted against budget — it is
  bounded by the platform hard cap, never unbounded. A request to *raise* a ceiling is a boundary
  crossing (Approval Center).

## 4. Creative production + media eval gate (as a service)

- **Media generation** orchestrated behind the `model` port: Imagen 4 / Adobe Firefly (image),
  Veo 3 (video), ElevenLabs (voice); assets versioned in object storage; **regenerate is metered**
  (billing spec) and each generation attributed to tenant + cost category.
- **Media eval gate (blocking, before any approval):** every generated/edited creative must pass
  **visual-brand, safety, IP/copyright, claims-substantiation, CAN-SPAM, AI-labeled, accessibility**
  checks. A failing check blocks the proposal; edits re-run the gate. This is the creative arm of the
  eval harness (`governance-subsystems.md` §5) and applies to ad, email, chat-video, and social
  creative alike.
- Shared by every surface that produces creative (merchant Campaigns, admin Growth Campaigns, comms
  media) — one service, not per-surface.

## 5. Social publishing service (Ayrshare)

- Multi-platform **scheduling + publish** (IG, TikTok, X, LinkedIn, etc.) via Ayrshare behind a
  `social` adapter; per-platform formatting/limits validated pre-publish; publish status + failures
  on the event bus. **Social publish tokens are least-privilege (publish-scoped), short-lived,
  revocable, per-tenant** via `secrets` — never a broad standing "post-on-behalf" grant.
- **Organic engagement pull-back** (reach/likes/comments) into `social_metric` rollups for the
  organic-KPI tiles. **Ingested engagement content (comments/replies) is untrusted data, never
  instructions** (`security-data-path.md` §1). Publishing brand-owned content is lower-stakes than
  paid spend, but **new channels / off-brand claims still route to HITL** and pass the media eval
  gate.

## 6. Conversion tracking

- **Meta Pixel/CAPI, Google Enhanced Conversions/tags** behind a first-class **`tracking` port**
  (`port-interfaces.md`), used to measure ad-driven conversions and feed §2 reconciliation + the
  incrementality model.
- **Consent + redaction enforced at the port boundary, fail-closed (not a caller convention).** The
  `tracking` adapter **rejects any egress lacking a `consentRef` or containing un-hashed PII** —
  server-side conversion signals are hashed/redacted before they leave, tracking consent is required,
  and residency is honored. This is a **required contract test**, symmetric with the `model` egress-
  before-inference and `comms` DLP tests. No raw PII to an ad platform, ever.

## 7. SEO / AEO content pipeline + AI-citation tracking

- **Content ops:** SEO/AEO page drafts (homepage, /product, /pricing rewrites) are proposals.
  **Public pricing/claims copy uses the pricing approval *class* (two-person + step-up)** — the same
  governance as a price change, because public price/claims text is money- and regulator-adjacent
  (`governance-subsystems.md` §3, `cost-margin-telemetry.md` §4). Publishing is versioned and
  reversible.
- **Ranking + AI-answer-citation monitoring:** track organic rank and **whether PalUp is cited in
  ChatGPT / Gemini / Perplexity answers** (the "38% cited" metric) via scheduled checks → `seo_metric`
  rollups. Scraped competitor/web pages and AI-answer text ingested for this are **untrusted data,
  never instructions** (`security-data-path.md` §1). Measurement only; no autonomous change to public
  pricing/claims without sign-off.

## 8. Adjacent — CRO / site experiments (brief)

- Site experiments (`experiment` entity) run a **canary variant → A/B measure → promote** flow that
  **mirrors the evolution pipeline's gating** (`governance-subsystems.md` §4): promote is HITL; a
  regression auto-reverts. Not re-specified here beyond noting it reuses that machinery.

## 9. Invariants (tests — `test-engineer` / `security-reviewer`)

1. No initial launch or spend-increase/ceiling-raise without an approved proposal; a rule may only
drive bounded pacing **inside** an already-approved campaign and can never originate a launch or
raise a ceiling; pause/stop is always allowed. 2. The **platform-native hard cap** (set on launch)
enforces the ceiling even during PalUp poll-lag/outage; poll-and-pause is secondary; any residual
overshoot is a reconciled cost-breaker event, never unbounded. 3. Every generated creative passes the media eval gate before an approval can be
granted; edits re-gate. 4. Connecting/allowlisting an ad or social platform is two-person authority.
5. Conversion-tracking egress is consent-gated + PII-hashed/redacted; no raw PII to a platform.
6. Platform-reported ROAS is reconciled against incrementality, not used as the fee basis.
7. SEO pricing/brand copy changes route to Brand/Pricing sign-off. 8. Every spend/publish/creative
action is audited + reversible.
