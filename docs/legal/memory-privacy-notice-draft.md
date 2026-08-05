# Shopper Privacy Notice — cross-visit memory (DRAFT FOR COUNSEL)

> ⚠️ **This is a DRAFT for counsel — NOT legal advice, NOT a published notice, NOT executed, NOT a
> sign-off.** It describes the **mechanics** of the cross-visit memory subsystem as actually implemented
> in this repo, in shopper-readable language, so a qualified attorney and the **Compliance/Legal owner**
> can turn it into a real notice. It deliberately draws **no legal conclusions** — it does not assert that
> any of this is GDPR-, CCPA-, or Art.-9-compliant, that the lawful basis is adequate, or that the consent
> copy is valid. Those are counsel's calls. Companion documents:
> `memory-dpa-addendum-draft.md` (processor terms) and `memory-open-questions-for-counsel.md` (the
> decisions counsel must make). Umbrella context: `provisions-brief.md` (instrument **B**, shopper-facing
> notices).

## 0. Status — nothing described here is running today

The feature this notice would cover is **inert**. `MEMORY_ADR_ACCEPTED` is a hardcoded `false`
(`packages/widget-memory/src/flag.ts:12`) and `isMemoryEnabled()` requires **both** that constant and the
operator flag `MEMORY_ENABLED === "true"` (`flag.ts:16-18`), so no fact is written, read, or renewed in
production regardless of configuration. The governing design record is
`docs/adr/0015-cross-visit-memory-eu-consent-gated.md`, whose **Status is "Proposed — NOT enacted"**; its
own sign-off section requires a privacy notice and a DPA **before** it can be Accepted. This draft exists
to satisfy that dependency; **publishing it, or the flag flip, remains a human decision.**

On sign-off, precisely: **no ADR acceptance, no notice publication, and no legal review of this draft has
occurred.** One narrower thing *is* recorded in the repo — ADR-0015 carries an "Amendment (2026-08-04 —
named owner + legal, retention)" covering the 30-day retention figures and the US Consent-2 fail-closed
default (`docs/adr/0015-cross-visit-memory-eu-consent-gated.md:9-16`; mirrored in
`packages/widget-memory/src/consent.ts:43-47` and `retention.ts:20-31`). We report that the repo says so;
**we have not verified who signed it, what they reviewed, or that it constitutes legal advice**, and it is
not a sign-off on this notice.

**Storage is not durable today.** The only `VectorPort` adapter that exists in this repo is an in-memory
reference implementation (`packages/platform-ports/src/vector-port.ts:117-159`), wired at
`packages/widget-backend/src/server.ts:198`; we searched all of `packages/` and found no other adapter. So
if the feature were enabled as it stands, notes would live only inside the serving process: they would be
lost on restart or redeploy, they would not be shared between instances, and a "forget me" call would
reach only the instance that happened to receive it. **Every retention and erasure statement below
describes what the code does to the store it is given — not a promise about durable data, because there is
no durable store yet.** A durable adapter is in development on a separate, unmerged branch; it is not part
of the code this notice describes. See **Q11**.

Everything below is therefore written as *"what would happen once enabled"*. Line numbers are as of commit
`fea7c0d`.

## 1. Who this notice is for, and who is responsible

The merchant (the store you are shopping on) decides to switch this on and is the consumer-facing party;
PalUp supplies the assistant and processes on the merchant's instructions (see `provisions-brief.md` §3,
§4). Memory is **per merchant**: the storage key is `${tenantId}::${anonId}`
(`packages/widget-memory/src/identity.ts:55-59`), and the vector store rejects a blank namespace and never
queries across namespaces (`packages/platform-ports/src/vector-port.ts:57-61,131-145`), so what one store
remembers is not visible to another.

> ⚠️ Counsel: that separation holds **only to the extent `tenantId` is actually merchant-derived.**
> `tenantId` comes from a verified widget token, and minting one requires both a configured
> `WIDGET_TOKEN_SECRET` and a registered embed key (`server.ts:355-361`). Any request that arrives without
> a valid token — `/chat`, `/consent`, `/forget` — falls back to a single hardcoded tenant,
> `RUNTIME_TENANT = "demo"` (`server.ts:54`, applied at `server.ts:618,684,751`), and that fallback is
> reachable by default because `WIDGET_AUTH_REQUIRED` defaults to `false` (`server.ts:260`). In that
> configuration every untokenized shopper shares one namespace prefix. The isolation claim above is a
> statement about the namespace scheme, not about the default deployment posture. See **Q4** and
> `memory-dpa-addendum-draft.md` §7 item 7.

## 2. What is remembered — short distilled facts, never your conversation

> **Draft shopper-facing text.** "I keep a few short notes about what you prefer — like *prefers
> fragrance-free* — not a copy of our conversation. Each note is one short sentence, and a note may
> include a brief quote of the words you used. I try to strip out things like payment card numbers and US
> Social Security numbers, and I throw a note away entirely if it still contains an email address or phone
> number."

Mechanics, and where each part is implemented:

| Statement | Implementation |
|---|---|
| Only distilled candidate facts are considered — never the raw transcript | `packages/widget-memory/src/distiller.ts` (`FactDistiller`, `createModelDistiller:213`); the extraction prompt forbids full-transcript/summary output (`distiller.ts:139-159`) |
| A note longer than 480 chars (3 × the 160-char cap) is **rejected outright**, not truncated | `distiller.ts:30,36,55` (`FACT_MAX_CHARS = 160`, `TRANSCRIPT_LIKE_CHARS`) |
| Payment cards + US SSNs are redacted before storage — **within the documented limits below** | `distiller.ts:57` calling `redactPII` (`packages/platform-ports/src/redaction.ts:43-59`) |
| A note still matching the email or phone patterns is **discarded** | `distiller.ts:42-43,58` |
| Notes are also capped at 160 characters | `distiller.ts:60` |
| No demographic, psychographic, or inferred budget/price-sensitivity extraction | prompt rules 2-3, `distiller.ts:143-150`; provenance is constrained to `"stated" \| "observed"` and a candidate carrying anything else is rejected whole (`distiller.ts:183-189`, re-checked at the persistence boundary in `packages/widget-memory/src/service.ts:92`) |
| **Disposition metadata is stored alongside the note** — `{axis, value, provenance, confidence, sourceQuote}`, where `sourceQuote` is a **short verbatim span of the shopper's own words** | `packages/widget-memory/src/types.ts:43-49`; written at `service.ts:96-105`; produced at `distiller.ts:102,125`. `sourceQuote` gets the same redaction + 160-char cap as the note text (`service.ts:97`) |
| Nothing is stored for a shopper the server has no subject key for | `packages/widget-backend/src/server.ts:913` (`remember` only runs when `signals.anonId` is present) |
| The raw turn (your message + the reply) **is sent to the AI model** to produce the notes, through the model port with the same card/SSN redaction | `server.ts:214` (`createRedactingModelPort`), `distiller.ts:218-225` |

**Counsel notes — three limits on the statements above.**

1. **The distillation step is a model call on the raw turn.** The notice must say that plainly — "the
   assistant reads what you type" is true of the chat generally, but the *memory* feature makes a
   **second** model call over the same text.
2. **Redaction is narrower than an absolute promise.** Card matching is Luhn-gated over separator-tolerant
   digit runs, so a mistyped or non-Luhn-valid number is not redacted; SSN matching covers only the
   separator-formatted `NNN-NN-NNNN` shape, and **bare 9-digit SSNs are an explicitly documented
   out-of-scope gap** (`redaction.ts:50-58`). The email/phone rejection is a deliberately "narrow,
   format-specific" regex pair (`distiller.ts:38-43`). Shopper-facing copy should therefore not promise
   that such data is *always* removed — the draft text above is worded accordingly.
3. **"Never the raw transcript" is true of the wired path, with one caveat.** The backend always supplies a
   model (`server.ts:202-216`), so the service selects the model-backed distiller (`service.ts:54`). The
   package also contains a fallback `createStubDistiller` (`distiller.ts:70-77`) that passes the shopper's
   own message through `sanitizeFact` as the candidate — i.e. it would store the raw message up to 160
   chars. It is not reachable from the backend today; noted because these drafts describe the package, not
   only the current wiring.

## 3. The two separate consents

There are exactly two independent consent tiers. **The serving decision is made server-side**: when a
`/chat` turn is processed, both tiers are read from the server's own consent-store record for this
(merchant, anonymous id), never from `signals.consent` in the request body
(`packages/widget-backend/src/signals.ts:71-83`). A client cannot make itself look consented merely by
saying so in a chat request.

> ⚠️ Counsel — the precise boundary. **The *subject* is server-derived and cannot be forged; the *choice*
> is client-supplied.** `tenantId` comes from the verified widget token (or the `RUNTIME_TENANT` fallback,
> §1), and the anonymous id must pass a format check (`identity.ts:64-74`). But `POST /consent` takes the
> two consent values **verbatim from the request body** and writes them for the supplied `anonId`
> (`server.ts:600-605,636-643`) — and that endpoint is unauthenticated whenever `WIDGET_AUTH_REQUIRED` is
> `false`, which is the default (`server.ts:260,614-618`). So a shopper's browser *can* record its own
> consent choice, and so can anyone else who learns that anonymous id. What the code prevents is a client
> *asserting* consent inline on the serving path; it does not prevent a client *writing* a consent record.
> This is the subject of **Q4**.

**Consent 1 — ordinary preferences.**
- If the deployment's region is `us`: an **opt-out** regime — ordinary notes may be written unless the
  shopper has explicitly said "out" (`packages/widget-memory/src/consent.ts:51`, `consent1 !== "out"`).
- **Every other region** (`eu`, `uk`, `other`, or unknown/absent): **fail-closed opt-in** — nothing is
  written without an explicit `consent1 === "in"` (`consent.ts:50-51`; the `unknown` case is treated
  exactly like the EU case).

**Consent 2 — health / special-category information.**
- **Always** requires an explicit, separate `consent2 === "in"` — in **every** region including the US
  (`consent.ts:52`). It is never bundled into Consent 1 and either can be given without the other
  (`consent.ts:38-47`).

Recorded choices are stored per (merchant, anonymous id) and written inside a transaction together with
their audit record (`packages/state-postgres/src/runtime-consent-store.ts:60-81`). If no record exists, the
default is `"unknown"` for both tiers — never "granted by omission"
(`runtime-consent-store.ts:46,88-91`).

**How the choice is offered** (`packages/widget/public/index.html`): the widget shows a first-run card
whose wording follows the region mode returned by the server (`showConsentPrompt:237-261`; server sets
`consentMode` at `server.ts:304`), plus an in-the-moment health card that appears only when the server
signals that this message revealed health information and the shopper has not yet decided
(`showSpecialConsentPrompt:269-288`; server-side trigger `server.ts:852-856`). None of this UI appears
unless the server reports `memoryEnabled: true` (`index.html:338-348`), which it never does today.

**A recalled note is re-checked against your *current* consent every time it is used** — write-time
consent alone is not enough (`packages/widget-brain/src/brain.ts:458-460,1135`). If consent was withdrawn
or was never explicitly "in", the note is not surfaced at all.

> ⚠️ Counsel: the US opt-out path and the read-time gate are **asymmetric** — a US shopper who never
> answers has `consent1 = "unknown"`, which *permits the write* (`consent.ts:51`) but *blocks every read*
> (`brain.ts:459`) and every retention renewal (`service.ts:164`). See open question **Q5**.

> ⚠️ Counsel — a second asymmetry, in the UI. The manage panel's checkboxes render as **checked only when
> the stored value is literally `"in"`** (`packages/widget/public/index.html:291-296,298-303`). Under the
> US opt-out default a shopper who has never answered sits at `"unknown"` — so the panel displays
> "Preferences: off" **while ordinary notes are in fact permitted and being written** (`consent.ts:51`).
> Displayed state and actual processing disagree in exactly the default US configuration. This bears
> directly on whether the consent artifact is valid; see **Q18**.

## 4. Health information gets its own, separate consent

> **Draft shopper-facing text.** "If you tell me about an allergy or another health matter, I answer you
> straight away and I **do not** need to store anything to do that. I only *remember* health information if
> you explicitly say yes when I ask. Remembering it lets me warn you away from products next time — it
> never lets me tell you something is safe."

- Every candidate note is classified **before** any write; the classifier treats Art.-9-style categories
  (allergy, health reactions/medication, pregnancy, skin sensitivity, biometric, genetic, sexual
  orientation) as special-category by conservative default
  (`packages/widget-memory/src/classifier.ts:34-49,67-74`).
- A merchant policy may only **narrow** what is remembered (drop a category); the type surface has no
  field that could reclassify special-category data as ordinary (`classifier.ts:22-30,70-73`).
- Special notes are only written when `consent2 === "in"` (`consent.ts:52`, enforced at
  `service.ts:81-82`).
- Remembered health notes are supplied to the model as fenced **data** that may only add caution, and only
  after every safety/guardrail branch has already had its chance to short-circuit the turn
  (`brain.ts:1119-1142`). A recalled special-category note is never allowed to steer style, pitch or price
  (`brain.ts:478`).

Counsel note: the classifier is a deterministic keyword map, so it can miss phrasings it does not list —
see open question **Q8**.

## 5. The anonymous id — per store, random, resettable

> **Draft shopper-facing text.** "To recognize you on your next visit I keep a random ID in your browser
> for this store. It isn't your name, it isn't built from your device, and it isn't shared with other
> stores. Clearing your browser storage, or tapping *Forget everything about me*, replaces it — and I
> start over."

| Statement | Implementation |
|---|---|
| 128 random bits, base32; nothing device- or shopper-derived feeds it (no fingerprinting) | **The id actually used in production is minted in the browser** (`index.html:194-202`, called at `:342`), not by the server. `identity.ts:35-37` is the server-side equivalent and is not on this path. |
| Randomness caveat | The browser mint prefers `crypto.getRandomValues`, but **falls back to `Math.random()`** if it is unavailable (`index.html:197`) — that fallback is not a cryptographic RNG. Rare in modern browsers, but it qualifies the "unguessable" premise that **Q4** rests on. |
| Stored in the browser's `localStorage`, namespaced per embed key so two merchants on the same origin never share it | `index.html:192,203-208` |
| Scoped per merchant server-side; `::` is rejected inside either component so a crafted id cannot reach another subject's slot | `identity.ts:39-59` |
| A client-supplied id is never trusted verbatim — it must pass a charset/length check or it is dropped | `identity.ts:64-74`, applied at `signals.ts:104`, `server.ts:636,702` |
| Resettable: "Forget everything about me" erases server-side and mints a brand-new id locally — **only when `/forget` actually returns ok** (PR-P6). A failed call now keeps the id and says so, because rotating it would strand the un-erased notes under an id the shopper no longer holds | `forgetMe()` in `index.html` |

## 6. How long notes are kept — 30 days that slide from your last visit

**The retention model, as the memory package implements it.**

- Both ordinary and health notes: **30 days**, as a **sliding window measured from last activity**, not
  from first capture (`packages/widget-memory/src/retention.ts:20-31,45-48`). The two classes are currently
  **equal** — set by the ADR-0015 amendment of 2026-08-04 (`retention.ts:26-31`; ADR-0015 Invariant 9,
  amended).
- A return visit re-stamps a note's expiry to `now + 30 days`, but only for a note whose tier the shopper
  currently consents to (literal `"in"`), and at most **once per day** (`service.ts:158-168`,
  `retention.ts:33-37`).
- **This is not a 30-day cap.** Because the window slides, a shopper who keeps coming back can have the
  same note held well beyond 30 days from when it was captured — for as long as they keep returning. There
  is **no absolute ceiling** anywhere in the code. Any shopper-facing copy must say "30 days after your
  last visit", never "kept for 30 days". See open question **Q2**.
- An expired note is never served and never renewed, even before anything deletes it (`service.ts:154`).
- A sweep function that actually deletes expired records exists (`retention.ts:69-100`) — see open question
  **Q11**: it is **not scheduled by any code in this repo today**, so between expiry and deletion an
  expired note is unreadable but still present.

> ⚠️ Counsel — **the sliding renewal cannot currently fire on the wired path.** Renewal requires
> `consent1`/`consent2 === "in"` on the recall context (`service.ts:164`), but the only production caller
> of `recall` — the memory-port adapter at `packages/widget-backend/src/server.ts:218-231` — passes
> `consent1: "unknown", consent2: "unknown"` hardcoded (`server.ts:227-228`), and the brain's recall port
> carries no consent field at all (`packages/widget-brain/src/types.ts:137-139`, called at
> `brain.ts:1127`). Those are the only two non-test `.recall(` call sites in `packages/`. So **as wired
> today no note would ever be renewed and no `ttl_renew` audit would ever be emitted** — retention would be
> a fixed 30 days from write. (The in-code comment at `server.ts:224-226` asserting that "recall itself
> never consults them" is out of date: recall does consult them, for renewal.) Counsel should be told
> which model to draft against, because the two differ materially and the gap is a few lines of wiring. Our
> assumption — stated as an assumption, not a decision — is that the sliding model is the intended one, so
> it is the one described above. See **Q2**.

> ⚠️ Counsel: none of this describes durable data. See §0 — the only fact-storage adapter in the repo is
> in-memory, so today "kept for 30 days" is bounded above by the lifetime of the serving process.

## 7. Your controls

| Control | What it does today | Implementation |
|---|---|---|
| "Preferences" / "Health notes" toggles | Records the choice (`POST /consent`); stops future writes of that tier and stops that tier being surfaced at read time | `index.html:291-318,224-235`; `server.ts:584-645`; `runtime-consent-store.ts:60-81`; read-time gate `brain.ts:1135` |
| "Forget everything about me" | Calls `POST /forget`, which erases the whole subject namespace (both tiers) via the vector port, audited; **on an ok response** the widget then mints a fresh anonymous id and confirms. On a failure (network or non-ok) it changes nothing and tells the shopper nothing was deleted — PR-P6; it used to confirm success and rotate the id regardless of the response | `forgetMe()` in `index.html`; `POST /forget` in `server.ts`; `packages/widget-memory/src/erasure.ts` (`eraseSubject` → `deleteNamespace`) |
| Clearing browser storage | Drops the id; nothing can be re-derived from it, so the shopper is effectively forgotten going forward (the server-side notes then age out on their own TTL) | `identity.ts:29-37`, `index.html:203-208` |

**Four gaps counsel must be told about before this notice is published:**

1. **Turning a toggle off does not delete what is already stored.** The ADR calls for erasure-first
   withdrawal, and per-tier purge functions exist (`erasure.ts:77-96` `withdrawConsent2`,
   `erasure.ts:107-126` `withdrawConsent1`) — but **no HTTP route calls them**; `/consent` only records the
   choice (`server.ts:643`). Existing notes stop being surfaced (`brain.ts:1135`) and stop being renewed
   (`service.ts:164`), then expire on their own. See **Q6**.
2. **There is no "show me / export what you remember" path.** No route in `packages/widget-backend/src`
   reads a subject's notes back to the shopper. Erasure is implemented; access/portability is not. See
   **Q7**.
3. **"Forget everything about me" is not a durable deletion guarantee today.** The call does what the code
   says — it deletes the whole subject namespace from the store it is pointed at and audits the action —
   but that store is the in-memory adapter (§0), so the erasure applies only to the serving instance that
   receives the request and to data that itself only lives in process memory. Until a durable adapter is
   merged, the notice must not promise deletion "from our systems". `/forget` also does **not** clear the
   shopper's consent record (`server.ts:708` erases the vector namespace only). See **Q9** and **Q11**.
4. **"Forget everything about me" does not delete the conversation itself, and structurally cannot.**
   `eraseSubject` deletes the subject's fact namespace only. The per-tenant **traffic log** keeps the
   shopper's message and the agent's reply (`logTraffic`, `packages/widget-backend/src/canary.ts` —
   redacted for cards/SSNs, keyed by a HASHED sessionId, trimmed to the last `TRAFFIC_KEEP_LAST` entries,
   default 5,000), and there is no `anonId → sessionId` link anywhere in the code, so `/forget` cannot
   reach it even in principle. The widget's own helper text now discloses this rather than implying a
   total erase (PR-P6); a notice saying "we delete everything about you" would be false for this reason
   before any other.

## 8. Logging

Every memory action is written to the append-only audit log — grants, writes (by class), recalls, renewals,
sweeps, erasures, merges (`packages/widget-memory/src/audit.ts:11-21`). What the log contains is
deliberately minimal:

- a **hashed, truncated** subject reference (`sha256("tenantId::anonId")`, first 16 hex chars) — **never**
  the raw anonymous id (`audit.ts:39-44`, mirrored in `runtime-consent-store.ts:51-53`);
- the sensitivity **class** and a **count** — **never** the note's text (`audit.ts:58-64`);
- the actor and a reversal path (`audit.ts:23-37`).

The log is append-only and hash-chained (`packages/platform-ports/src/runtime-state-port.ts:37-41,100-117`;
Postgres adapter issues no UPDATE/DELETE against `rs_audit`,
`packages/state-postgres/src/postgres-runtime-store.ts:14-18,60-67`).

> ⚠️ Counsel — do not read "immutable" as stronger than the code claims. The port's own trust assumption
> states that the chain is **tamper-evident, not tamper-proof by itself**: in-place mutation, reorder,
> mid-chain removal and naive insertion are caught by `verifyAudit`, but **tail-truncation and a full
> re-hash are not detectable from the chain alone**, because no secret is stored
> (`runtime-state-port.ts:98-104`). Immutability therefore rests on a *deploy-time* obligation — an
> INSERT-only GRANT on the audit table — which is infrastructure configuration, not code in this repo
> (`postgres-runtime-store.ts:13-18,65-67`). We have not verified any deployed database configuration.

Counsel must reconcile the append-only audit log against erasure requests — see **Q9** and
`provisions-brief.md` §7 item 5.

## 9. Who else sees this

- **No cross-merchant profile.** Enforced by the namespace scheme and the port's no-cross-namespace
  guarantee (`identity.ts:55-59`, `vector-port.ts:7-11,131-145`; ADR-0015 Inv 2).
- **The AI model provider.** Notes are appended to the model prompt as fenced data on the recall path
  (`brain.ts:1138-1142`) and the raw turn is sent to the model during distillation
  (`distiller.ts:218-225`). Model access is through the model port; the production adapter is Vertex
  (Gemini) when `GOOGLE_CLOUD_PROJECT` is configured, otherwise a local mock
  (`packages/widget-backend/src/model.ts:12-17`). The sub-processor disclosure belongs in the DPA
  (`memory-dpa-addendum-draft.md` §5) and in the merchant's own notice.
- **PalUp operators.** Through the audit log only, in the minimized form described in §8.

## 10. What this draft deliberately does not say

- It makes **no** claim that any of this is lawful, sufficient, or compliant in any jurisdiction.
- It does **not** state a lawful basis. ADR-0015 frames Consent 1 as Art. 6 and Consent 2 as Art. 9
  (`docs/adr/0015-cross-visit-memory-eu-consent-gated.md`, "Consent UX" section) — that framing is the
  engineering team's, not a legal determination.
- It does **not** cover children/minors (nothing in the code detects or gates on age — searched
  `packages/widget-memory/src` and `packages/widget-backend/src` for age/minor handling; none found).
- It does **not** cover the rest of the widget's processing (chat logs, telemetry, orders) — only
  cross-visit memory.
- Regional scope is currently a **deploy-level** setting (`MERCHANT_REGION`, default `"us"`,
  `server.ts:293-296`), not per-shopper geolocation. See **Q10**.
- It does **not** describe encryption at rest for health notes. ADR-0015 Invariant 9 calls for it and
  **it is not implemented** — there is no encryption anywhere in `packages/widget-memory` (searched the
  package; the only `node:crypto` uses are `randomUUID`, `randomBytes` and the audit `sha256`). No
  shopper-facing copy may say health notes are kept encrypted. Note that ADR-0015's own draft Consent-2
  prompt copy contains the phrase "I'll keep it encrypted"
  (`docs/adr/0015-cross-visit-memory-eu-consent-gated.md:105-108`); the prompt copy actually shipped in the
  widget does **not** make that claim (`index.html:277`), and it must not be reintroduced until the control
  exists. See **Q16**.
