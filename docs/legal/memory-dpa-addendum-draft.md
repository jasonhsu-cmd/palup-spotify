# DPA Addendum — cross-visit shopper memory (DRAFT FOR COUNSEL)

> ⚠️ **This is a DRAFT for counsel — NOT legal advice, NOT a binding agreement, NOT executed terms, NOT a
> sign-off.** It is an engineering description of the processing performed by the cross-visit memory
> subsystem, in the shape of a DPA addendum, so a qualified attorney and the **Compliance/Legal owner** can
> draft the real instrument. **No DPA exists in this repo** (`provisions-brief.md` §0 — "No agreements
> currently exist"), and this addendum presupposes a base DPA that has not been written. Every clause below
> must be validated, completed and made jurisdiction-correct by a licensed lawyer before use. It asserts **no
> legal conclusion** — in particular it does not claim the measures described are "appropriate", "adequate",
> or sufficient under Art. 28/32 or any other provision.
>
> Companions: `memory-privacy-notice-draft.md` (shopper-facing), `memory-open-questions-for-counsel.md`
> (decisions counsel must make), `provisions-brief.md` §4 (instrument **C**, the base DPA).

## 0. Status and scope of this addendum

The processing described is **not occurring**. `MEMORY_ADR_ACCEPTED` is a hardcoded `false`
(`packages/widget-memory/src/flag.ts:12`) and `isMemoryEnabled()` requires that constant **and** the
operator flag (`flag.ts:16-18`), so in production the memory service is never constructed
(`packages/widget-backend/src/server.ts:200-217`) and no fact is written or read. This addendum describes
the processing that **would** occur after a human-only flip of that constant. Line numbers are as of commit
`fea7c0d`.

Scope: cross-visit shopper memory only. Other processing (chat serving, the traffic/shadow-grading log,
telemetry, Shopify order lookups, marketing comms) is out of scope here and belongs in the base DPA.

## 1. Roles

Consistent with `provisions-brief.md` §4: merchant = **controller**, PalUp = **processor**, downstream
vendors = **sub-processors**. Nothing in the code contradicts that allocation; it is a legal
characterization for counsel to confirm, not something the code can establish.

## 2. Categories of data subjects

- **Shoppers on a merchant's storefront**, in two states:
  - *guest* — known only by a per-merchant random anonymous id (`packages/widget-memory/src/identity.ts:35-37`);
  - *account* — post sign-up merge, keyed `acct:${accountId}` (`packages/widget-memory/src/merge.ts:21-23`).
    **Note:** the merge function exists but **no route calls it** (searched `packages/widget-backend/src`),
    so today only the guest tier is reachable.

## 3. Categories of personal data

| Category | Content | Where written |
|---|---|---|
| **Pseudonymous identifier** | 128-bit random, base32, per merchant; browser-stored; not device-derived | `identity.ts:35-37`; widget mirror `packages/widget/public/index.html:194-202` |
| **Ordinary "commerce" facts** | ≤160-char distilled preference/observation sentences, card/SSN-redacted, discarded if they still contain an email or phone number | `packages/widget-memory/src/distiller.ts:30,42-43,51-61`; stored `packages/widget-memory/src/service.ts:100-108` |
| **Special-category facts (Art.-9-style)** | Same shape, but classified as health/allergy/pregnancy/biometric/genetic/sexual-orientation by a conservative keyword map | `packages/widget-memory/src/classifier.ts:34-49,67-74` |
| **Disposition metadata** | Optional `{axis, value, provenance ∈ {stated, observed}, confidence, sourceQuote}` style signals; "inferred" provenance is structurally impossible; invalid ⇒ whole candidate rejected | `distiller.ts:102,125,183-189`; re-validated at the persistence boundary `service.ts:92` |
| **Consent records** | Two tri-states (`in`/`out`/`unknown`) per (merchant, anonymous id) | `packages/state-postgres/src/runtime-consent-store.ts:26-31,60-81` |
| **Audit records** | Action, hashed subject reference, sensitivity class, count, reversal path — **no fact text, no raw id** | `packages/widget-memory/src/audit.ts:39-64` |
| **Derived expiry metadata** | `expiresAt` ISO timestamp per fact | `service.ts:103`; `packages/widget-memory/src/types.ts:43-49` |

Explicitly **not** collected by design: demographics, psychographics, and inferred willingness-to-pay
(prompt rules 2-3, `distiller.ts:143-150`); raw transcripts (`distiller.ts:36,55`).

## 4. Purposes and processing operations

1. **Distillation** — one model call per turn over the raw shopper message + agent reply to extract 0-N
   candidate facts (`distiller.ts:213-262`, invoked from `service.ts:66`).
2. **Classification** — sensitivity class assigned before any write (`classifier.ts:67-74`, `service.ts:78`).
3. **Consent gating** — server-side decision table (`packages/widget-memory/src/consent.ts:49-62`, applied
   `service.ts:81-82`).
4. **Storage** — upsert into the subject's vector namespace with class + expiry metadata
   (`service.ts:100-136`).
5. **Recall / personalization** — read the subject's unexpired facts, re-check the shopper's *current*
   consent per tier, and append them to the model prompt as fenced data that may only add caution
   (`service.ts:141-189`; `packages/widget-brain/src/brain.ts:1126-1156`, read-time gate `brain.ts:458-460`).
6. **Retention maintenance** — TTL-on-read drop plus throttled sliding renewal (`service.ts:154,158-168`);
   a reclamation sweep function exists but is unscheduled (`packages/widget-memory/src/retention.ts:69-100`).
7. **Erasure** — whole-subject erasure on shopper request (`packages/widget-memory/src/erasure.ts:63-69`,
   route `server.ts:660-710`).
8. **Audit** — every one of the above is logged (`audit.ts:11-21`).

## 5. Sub-processing and portability posture

All external capability access is through the **ports** in `packages/platform-ports/` (ADR-0001; CLAUDE.md
§3.3), so the sub-processor set is a function of which adapter is deployed, not of feature code:

| Capability | Port | Adapter in this repo today |
|---|---|---|
| Fact storage | `VectorPort` (`packages/platform-ports/src/vector-port.ts:43-53`) | **In-memory reference adapter only** (`vector-port.ts:117-159`), selected at `server.ts:198`. **No durable/cloud adapter exists.** |
| Model inference (distillation + serving) | `ModelPort` | Vertex AI (Gemini) when `GOOGLE_CLOUD_PROJECT` is configured, else a local mock (`packages/widget-backend/src/model.ts:12-17`); wrapped in card/SSN redaction (`server.ts:214`) |
| Consent records, audit log, rate limits | `RuntimeStatePort` | Postgres (Cloud SQL via `DATABASE_URL`) or in-memory (`packages/state-postgres/src/postgres-runtime-store.ts`) |

Consequences counsel should note:
- Because the only `VectorPort` adapter is in-memory, memory facts today live **in the serving process**,
  are lost on restart, and `POST /forget` can only erase from the instance that receives the call. A durable
  adapter is a tracked prerequisite, not shipped.
- The model provider processes the **raw turn text** during distillation, not just the distilled fact. The
  sub-processor exhibit and any zero-/limited-retention commitments must cover that call
  (`provisions-brief.md` §4, "Model-provider commitment" and "Model-specific retention").

## 6. Security measures — **as actually implemented today**

Each is verifiable in code; none of them is offered as a legal adequacy claim.

**Isolation**
- Namespace = `${tenantId}::${anonId}`; blank namespaces rejected; no cross-namespace query
  (`identity.ts:55-59`, `vector-port.ts:57-61,131-145`).
- `::` rejected inside either component, blocking namespace injection into another subject/tenant
  (`identity.ts:39-46`).
- Client-supplied anonymous ids must pass a charset/length check before keying anything
  (`identity.ts:64-74`; applied `packages/widget-backend/src/signals.ts:104`, `server.ts:636,702`).
- Postgres adapter applies a `tenant_id` predicate on every statement
  (`postgres-runtime-store.ts:13-15`).

**Data minimization**
- Transcript-shaped input rejected outright; card/SSN redaction; contact-info rejection; 160-char cap
  (`distiller.ts:36,51-61`).
- Extraction prompt forbids demographic/psychographic/inferred-budget facts; invalid provenance rejects the
  whole candidate, re-validated at the persistence boundary (`distiller.ts:143-159,183-189`; `service.ts:92`).
- Redaction wrapper on the model call so pasted cards/SSNs do not reach the provider (`server.ts:205-214`).
- Audit records carry a hashed, truncated subject reference and never the fact text (`audit.ts:39-64`;
  `runtime-consent-store.ts:51-53,73-74`).

**Consent enforcement**
- Server-derived only; the client cannot assert its own consent (`signals.ts:71-83`).
- Fail-closed defaults: no record ⇒ `"unknown"` (`runtime-consent-store.ts:46`); every non-US region
  requires explicit `"in"`; special-category requires explicit `"in"` everywhere (`consent.ts:49-62`).
- Re-checked at read time, per tier, on every turn (`brain.ts:458-460,1135`).
- Special-category facts never migrate to an account without account-level Consent 2 (`merge.ts:55`).

**Integrity / accountability**
- Append-only, hash-chained audit with a verification routine
  (`packages/platform-ports/src/runtime-state-port.ts:37-41,100-117`); the Postgres adapter issues no
  UPDATE/DELETE against `rs_audit` (`postgres-runtime-store.ts:14-18,60-67`).
- Chain head anchored out-of-band to stdout → Cloud Logging (`server.ts:956-960`).
- Consent write and its audit record commit in one transaction (`runtime-consent-store.ts:67-80`).
- Erasure enumeration **fails closed** rather than reporting a partial purge as complete
  (`erasure.ts:44-54`); whole-tenant erasure **throws** rather than silently no-op-ing (`erasure.ts:138-144`).

**Availability / abuse control**
- Operator kill switch halts memory writes on `/chat` (`server.ts:913`) and returns 503 on `/consent`
  (`server.ts:631-634`) and `/forget` (`server.ts:697-700`).
- Per-IP and per-tenant rate limits on `/consent` and `/forget` (`server.ts:590-596,619-627,661-670,687-693`).
- Feature-level inertness: the double gate cannot be flipped by configuration alone (`flag.ts:1-18`).

## 7. Security measures **NOT implemented today** (open items — must not be represented as in place)

1. **Encryption at rest for special-category facts.** ADR-0015 Invariant 9 calls for it; there is **no
   encryption anywhere in `packages/widget-memory`** (searched the package for `encrypt`/`crypto` — the only
   `node:crypto` uses are `randomUUID`, `randomBytes` and the audit `sha256`: `service.ts:1`,
   `identity.ts:1`, `audit.ts:1`). Application-layer AES-256-GCM exists elsewhere in the codebase
   (`packages/widget-backend/src/customer-grant-store.ts:28-48`, for OAuth grants) and is **not** applied to
   memory facts. Tracked as go-live item #2.
2. **Durable, portable fact storage.** Only the in-memory `VectorPort` adapter exists (`vector-port.ts:117`),
   so there is no at-rest storage layer to encrypt, back up, or reason about yet. Tracked as go-live item #1.
3. **Whole-tenant erasure.** `eraseTenant` throws `NotImplemented` (`erasure.ts:138-144`) — there is no
   "delete every subject under this merchant" operation, which is what a controller offboarding/termination
   clause would need.
4. **Erasure-first consent withdrawal.** `withdrawConsent1` / `withdrawConsent2` exist (`erasure.ts:77-126`)
   but **no route calls them**; `POST /consent` only records the choice (`server.ts:643`).
5. **Data-subject access / portability for memory.** No route returns a subject's stored facts.
6. **Scheduled retention sweep.** `sweepExpired` (`retention.ts:69-100`) has no caller in serving code; the
   `store.sweepExpired()` at `server.ts:964` is the *runtime KV* sweep, a different mechanism. Expiry is
   enforced on read (`service.ts:154`), so expired facts are not served — but they are not yet deleted.
7. **Authentication on the memory endpoints in the default configuration.** `WIDGET_AUTH_REQUIRED` defaults
   to `false` (`server.ts:260`); with it off, `/consent` and `/forget` accept unauthenticated calls and fall
   back to `RUNTIME_TENANT` (`server.ts:614-618,679-684`). Tracked as go-live item #3. See **Q3**.
8. **Per-shopper region determination.** `MERCHANT_REGION` is a deploy-level env var defaulting to `"us"`
   (`server.ts:293-296`), with an in-code note that it "should become geo-derived from the request". See **Q4**.
9. **Per-merchant memory on/off control.** `memoryServiceEnabled` is process-wide (`server.ts:200`); there is
   no per-tenant toggle. ADR-0015 lists this as still open ("Merchant control").
10. **Retention limits on consent records and audit entries.** `recordConsent` writes with no TTL
    (`runtime-consent-store.ts:68`), and the audit log is append-only by design — both outlive the 30-day
    fact TTL. `POST /forget` does not clear the consent record (`server.ts:708`). See **Q8**.
11. **Row-level security and the audit-table GRANT.** Both are documented as *deploy/infra* obligations, not
    enforced by this code (`postgres-runtime-store.ts:13-15,65-67`). I have not verified any deployed
    database configuration — that is outside this repo.
12. **Contractual/operational measures** (breach notification timelines, SCCs/transfer mechanism, audit
    rights, sub-processor change notice, residency commitments, retention of backups) exist nowhere in code
    and must be drafted from scratch — `provisions-brief.md` §4 sketches the shape.

## 8. Retention

- Facts: **30 days from last activity**, both classes equal, sliding, renewal throttled to once/day and
  audited (`retention.ts:24,31,33-37,45-48`; `service.ts:158-168`). No absolute cap (see **Q2**).
- Enforcement is on read today; deletion depends on the unscheduled sweep (§7 item 6).
- Consent records and audit entries: unbounded (§7 item 10).
- On termination/offboarding: no whole-tenant erasure exists (§7 item 3), so a "delete or return on
  termination" clause has no implementation behind it yet.

## 9. Assistance with data-subject requests

| Right | Status |
|---|---|
| Erasure ("forget me") | Implemented per subject, audited, and works even while the feature is off (`server.ts:655-659,708`; `erasure.ts:63-69`) |
| Withdrawal of consent | Recorded and forward-effective; **does not purge** (§7 item 4) |
| Access / portability | Not implemented (§7 item 5) |
| Objection / restriction | No dedicated mechanism beyond withdrawal + erasure |
| Rectification | No mechanism (a wrong remembered fact can only be erased wholesale) |
| Merchant-initiated bulk erasure | Not implemented (§7 item 3) |

## 10. Audit and evidence available to a controller

Per-action audit entries with hashed subject reference, class and count (`audit.ts:11-64`) for:
`consent.granted`, `consent.withdrawn`, `write.ordinary`, `write.special`, `recall`, `erase.subject`,
`erase.tenant`, `merge`, `ttl_sweep`, `ttl_renew`. Plus `consent.record` from the consent store
(`runtime-consent-store.ts:72`). Chain integrity is verifiable (`runtime-state-port.ts:109-117`) and anchored
out-of-band (`server.ts:956-960`). There is **no controller-facing UI or API** to read these today — access
is operator-side only.
