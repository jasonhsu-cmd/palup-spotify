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
to satisfy that dependency; **publishing it, or the flag flip, remains a human decision** and no sign-off
of any kind has occurred.

Everything below is therefore written as *"what would happen once enabled"*. Line numbers are as of commit
`fea7c0d`.

## 1. Who this notice is for, and who is responsible

The merchant (the store you are shopping on) decides to switch this on and is the consumer-facing party;
PalUp supplies the assistant and processes on the merchant's instructions (see `provisions-brief.md` §3,
§4). Memory is **per merchant**: the storage key is `${tenantId}::${anonId}`
(`packages/widget-memory/src/identity.ts:55-59`), and the vector store rejects a blank namespace and never
queries across namespaces (`packages/platform-ports/src/vector-port.ts:57-61,131-145`), so what one store
remembers is not visible to another.

## 2. What is remembered — short distilled facts, never your conversation

> **Draft shopper-facing text.** "I keep a few short notes about what you prefer — like *prefers
> fragrance-free* — not a copy of our conversation. Each note is one short sentence. Anything that looks
> like a payment card, a US Social Security number, an email address or a phone number is either removed
> or the note is thrown away instead of being saved."

Mechanics, and where each part is implemented:

| Statement | Implementation |
|---|---|
| Only distilled candidate facts are considered — never the raw transcript | `packages/widget-memory/src/distiller.ts` (`FactDistiller`, `createModelDistiller:213`); the extraction prompt forbids full-transcript/summary output (`distiller.ts:139-159`) |
| A note longer than 480 chars (3 × the 160-char cap) is **rejected outright**, not truncated | `distiller.ts:30,36,55` (`FACT_MAX_CHARS = 160`, `TRANSCRIPT_LIKE_CHARS`) |
| Payment cards + US SSNs are redacted before storage | `distiller.ts:57` calling `redactPII` (`packages/platform-ports/src/redaction.ts:42-62`) |
| A note still containing an email address or phone number is **discarded** | `distiller.ts:42-43,58` |
| Notes are also capped at 160 characters | `distiller.ts:60` |
| No demographic, psychographic, or inferred budget/price-sensitivity extraction | prompt rules 2-3, `distiller.ts:143-150`; provenance is constrained to `"stated" \| "observed"` and a candidate carrying anything else is rejected whole (`distiller.ts:183-189`, re-checked at the persistence boundary in `packages/widget-memory/src/service.ts:92`) |
| Nothing is stored for a shopper the server has no subject key for | `packages/widget-backend/src/server.ts:913` (`remember` only runs when `signals.anonId` is present) |
| The raw turn (your message + the reply) **is sent to the AI model** to produce the notes, through the model port with the same card/SSN redaction | `server.ts:214` (`createRedactingModelPort`), `distiller.ts:218-225` |

Counsel note: the distillation step is a model call on the raw turn. The notice must say that plainly —
"the assistant reads what you type" is true of the chat generally, but the *memory* feature makes a
**second** model call over the same text.

## 3. The two separate consents

There are exactly two independent consent tiers, decided **server-side** — a shopper's browser cannot
assert its own consent (`packages/widget-backend/src/signals.ts:71-83`, which sources both tiers from the
server's own consent-store lookup, never from the request body).

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
> (`brain.ts:459`) and every retention renewal (`service.ts:164`). See open question **Q1** and **Q2**.

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
see open question **Q7**.

## 5. The anonymous id — per store, random, resettable

> **Draft shopper-facing text.** "To recognize you on your next visit I keep a random ID in your browser
> for this store. It isn't your name, it isn't built from your device, and it isn't shared with other
> stores. Clearing your browser storage, or tapping *Forget everything about me*, replaces it — and I
> start over."

| Statement | Implementation |
|---|---|
| 128 random bits, base32; nothing device- or shopper-derived feeds it (no fingerprinting) | `identity.ts:35-37` (server-side) and the widget's mirror `index.html:194-202` |
| Stored in the browser's `localStorage`, namespaced per embed key so two merchants on the same origin never share it | `index.html:192,203-208` |
| Scoped per merchant server-side; `::` is rejected inside either component so a crafted id cannot reach another subject's slot | `identity.ts:39-59` |
| A client-supplied id is never trusted verbatim — it must pass a charset/length check or it is dropped | `identity.ts:64-74`, applied at `signals.ts:104`, `server.ts:636,702` |
| Resettable: "Forget everything about me" erases server-side and mints a brand-new id locally | `index.html:320-333` |

## 6. How long notes are kept — 30 days from your last visit

- Both ordinary and health notes: **30 days**, as a **sliding window measured from last activity**
  (`packages/widget-memory/src/retention.ts:24,31,45-48`). The two classes are currently **equal** — set by
  the ADR-0015 amendment of 2026-08-04 (`retention.ts:26-31`; ADR-0015 Invariant 9, amended).
- A return visit re-stamps a note's expiry to `now + 30 days`, but only for a note whose tier the shopper
  currently consents to (`"in"`), and at most **once per day** (`service.ts:158-168`,
  `retention.ts:33-37`).
- An expired note is never served and never renewed, even before anything deletes it
  (`service.ts:154`).
- A sweep function that actually deletes expired records exists (`retention.ts:69-100`) — see open question
  **Q9**: it is **not scheduled by any code in this repo today**.

> ⚠️ Counsel: because the window slides on every return, a regularly-returning shopper's notes can be kept
> indefinitely. There is **no absolute cap** in the code. See open question **Q2**.

## 7. Your controls

| Control | What it does today | Implementation |
|---|---|---|
| "Preferences" / "Health notes" toggles | Records the choice (`POST /consent`); stops future writes of that tier and stops that tier being surfaced at read time | `index.html:291-318,224-235`; `server.ts:584-645`; `runtime-consent-store.ts:60-81`; read-time gate `brain.ts:1135` |
| "Forget everything about me" | Calls `POST /forget`, which erases the whole subject namespace (both tiers) via the vector port, audited; then the widget mints a fresh anonymous id | `index.html:310-333`; `server.ts:660-710`; `packages/widget-memory/src/erasure.ts:63-69` (`eraseSubject` → `deleteNamespace`) |
| Clearing browser storage | Drops the id; nothing can be re-derived from it, so the shopper is effectively forgotten going forward (the server-side notes then age out on their own TTL) | `identity.ts:29-37`, `index.html:203-208` |

**Two gaps counsel must be told about before this notice is published:**

1. **Turning a toggle off does not delete what is already stored.** The ADR calls for erasure-first
   withdrawal, and per-tier purge functions exist (`erasure.ts:77-96` `withdrawConsent2`,
   `erasure.ts:107-126` `withdrawConsent1`) — but **no HTTP route calls them**; `/consent` only records the
   choice (`server.ts:643`). Existing notes stop being surfaced (`brain.ts:1135`) and stop being renewed
   (`service.ts:164`), then expire on their own. See **Q5**.
2. **There is no "show me / export what you remember" path.** No route in `packages/widget-backend/src`
   reads a subject's notes back to the shopper. Erasure is implemented; access/portability is not. See
   **Q6**.

## 8. Logging

Every memory action is written to the immutable audit log — grants, writes (by class), recalls, renewals,
sweeps, erasures, merges (`packages/widget-memory/src/audit.ts:11-21`). What the log contains is
deliberately minimal:

- a **hashed, truncated** subject reference (`sha256("tenantId::anonId")`, first 16 hex chars) — **never**
  the raw anonymous id (`audit.ts:39-44`, mirrored in `runtime-consent-store.ts:51-53`);
- the sensitivity **class** and a **count** — **never** the note's text (`audit.ts:58-64`);
- the actor and a reversal path (`audit.ts:23-37`).

The log is append-only and hash-chained (`packages/platform-ports/src/runtime-state-port.ts:37-41,100-117`;
Postgres adapter issues no UPDATE/DELETE against `rs_audit`,
`packages/state-postgres/src/postgres-runtime-store.ts:14-18,60-67`). Counsel must reconcile "immutable
audit" against erasure requests — see **Q8** and `provisions-brief.md` §7 item 5.

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
  `server.ts:293-296`), not per-shopper geolocation. See **Q4**.
