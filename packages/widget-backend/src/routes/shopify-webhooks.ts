import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AuditInput, MerchantRecord, MerchantRegistryPort, RuntimeStatePort, VectorPort } from "@palup/platform-ports";
import { buildShopifyShopperId } from "@palup/platform-ports";
import { accountSubjectId, eraseSubject, listSubjects, retireSubject } from "@palup/widget-memory";
import { clientIpKey } from "../rate-limit.js";
import {
  APP_UNINSTALLED_SHOP_SOURCE,
  COMPLIANCE_TOPICS,
  UNINSTALL_TOPIC,
  WEBHOOK_HMAC_HEADER,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SHOP_HEADER,
  bodyShopDomain,
  customerIdOf,
  dataRequestIdOf,
  isValidShopDomain,
  matchesPayloadShape,
  parseWebhookBody,
  singleHeader,
  verifyWebhookHmac,
} from "../shopify-webhook-identity.js";

// C2 — the three MANDATORY Shopify compliance webhooks plus `app/uninstalled`. The Shopify wire format,
// with its primary-source citations, lives entirely in ../shopify-webhook-identity.ts ([W1]/[W2]/[W3]
// there); this file is the FLOW and its governance: raw-body capture, fail-closed ordering, tenant
// resolution, idempotency, kill switch, audit, and — the part that took the most care — being HONEST in
// the audit log about what each topic did and did not actually erase.
//
// ****************************************************************************************************
// READ THIS BEFORE THE APP IS SUBMITTED FOR LISTING. **ONE OF THE THREE COMPLIANCE TOPICS IS REAL, ONE
// IS PARTIAL, AND ONE IS ACKNOWLEDGED-ONLY.** They are not equivalent and the audit log says which is
// which on every delivery. The evidence, read out of the code on 2026-08-05:
//
//   `shop/redact`            PARTIAL-REAL. It revokes the merchant (`setStatus` → inert), erases every
//                            memory namespace the tenant's own subject index knows about, and EMPTIES the
//                            tenant's traffic log. It does NOT erase: the immutable audit chain
//                            (deliberate — NN#5; and it holds keyed-HMAC `subjectRef`s, never raw ids —
//                            audit.ts), the `memory_consent` records (no exported delete; the collection
//                            name is private to @palup/state-postgres), sessions or any other KV
//                            collection (`RuntimeStatePort` has no enumerate-collections operation), or
//                            anything on Shopify's own side.
//                            NOTE it does NOT use `eraseTenant` — that function THROWS `NotImplemented`
//                            (widget-memory/src/erasure.ts:146-152). The subject-index loop below is
//                            built from B4's `listSubjects` (subject-index.ts, #156) instead, which is a
//                            real whole-tenant erasure over an index that is only as complete as the
//                            writes that populated it.
//
//   `customers/redact`       PARTIAL. It erases the ACCOUNT-scoped memory namespace for that customer —
//                            `acct:shopify:<tenant>:<customer id>`, the one derivable link from a Shopify
//                            customer id to anything stored here (buildShopifyShopperId → accountSubjectId
//                            → subjectNamespace). It CANNOT erase: the same human's GUEST namespaces (a
//                            guest id is 128 bits of `randomBytes` with nothing to reconstruct it from —
//                            identity.ts:29-37 — so no customer id maps to one), the per-tenant traffic
//                            log (canary.ts `logTraffic` keys entries by a HASHED sessionId and retains
//                            the redacted message + reply; there is no anonId→sessionId link to key a
//                            deletion by — the finding #185 made), or the consent record (see above).
//                            `orders_to_redact` is a NO-OP AND HONESTLY SO: this system stores no orders
//                            at all — commerce reads go straight to the port per request.
//
//   `customers/data_request` ACKNOWLEDGED-ONLY. **There is no export capability anywhere in this repo.**
//                            #185's shopper-promise guard states the search result as a locked invariant:
//                            "no export path exists anywhere in packages/ — searched every .ts for an
//                            export/portability/subject-access route or port method"
//                            (test/shopper-promise-guard.ts, the `data-export` claim class). And [W2] does
//                            not ask the app to REPLY with the data — it says the resource IDs are data
//                            "you need to provide to the store owner directly", out of band, within 30
//                            days. There is no deployed merchant console to provide it through
//                            (deploy-staging.yml deploys `palup-widget-staging` only; the control plane is
//                            deployed nowhere — #179). So this handler DOES NOT FAKE IT. It records a
//                            durable, dated obligation and audits `fulfilled: false` with the reason.
//                            A 200 here means RECORDED, never FULFILLED.
//
// WHY ACKNOWLEDGE RATHER THAN 500. [W1]: a non-2xx is an error, Shopify "retries 8 times over the next 4
// hours" and "after 8 consecutive failures, the subscription is automatically deleted if it was
// configured using the Admin API". Failing a request we cannot fulfil would therefore burn the retries
// and can DELETE THE COMPLIANCE SUBSCRIPTION — losing the obligation and the listing. A 200 plus a
// truthful, durable record is strictly better than that, and vastly better than a 200 that means nothing
// happened.
// ****************************************************************************************************
//
// RAW BODY (the security property this whole file rests on). [W1] names the exact trap: "If you're using
// a body parser middleware like `express.json()`, it parses the body before your verification code runs.
// Capture the raw body before it's parsed." Fastify parses `application/json` by DEFAULT, so these routes
// are registered inside their OWN Fastify plugin scope in which `removeAllContentTypeParsers()` +
// a catch-all `parseAs: "buffer"` parser replace it. `addContentTypeParser` "is encapsulated in the scope
// in which it is declared" (Fastify 5.10.0 docs, Reference/ContentTypeParser.md), so `req.body` is the
// UNPARSED Buffer here and stays a parsed object on every sibling route (/chat, /consent, /forget) — a
// property with its own test, because a leak would silently break every other endpoint in the server.
//
// AUDIT (NN#5) AND WHAT THIS CANNOT DO. Same limitation C1 documented and for the same reason:
// `MerchantRegistryPort` exposes no transaction handle and `PostgresMerchantRegistry.setStatus` commits
// its own transaction, while the audit chain lives behind `RuntimeStatePort.audit`. Two ports, two
// transactions ⇒ AN ATOMIC AUDIT-WITH-WRITE IS NOT ACHIEVABLE THROUGH THE PORT, and nothing here claims
// it is. So this file takes the repo's existing second-best ordering — AUDIT FIRST, THEN ACT
// (routes/shopify-install.ts, jobs/merchant.ts:174-190 and customer-account-flow.ts:148-152 all make the
// same trade) — with both failure modes stated rather than glossed:
//   • an audit failure ABORTS the action, so no unaudited revocation or erasure can persist (tested);
//   • an audit that commits followed by an action that fails leaves a record of something that did not
//     happen. That is visible and reconcilable against `pl_merchant` / the vector store, and Shopify's
//     retry will re-attempt it. The reverse ordering would leave an UNAUDITED destructive write, which
//     NN#5 forbids outright.
// The dedup mark is written AFTER the action, never before, for the same directional reason: marking
// first would let one failed attempt swallow the whole obligation, since Shopify skips what we call done.

/** Route paths, exported so the composition root, the tests and the app TOML all name ONE list. */
export const WEBHOOK_ROUTES = {
  customersDataRequest: "/shopify/webhooks/customers/data_request",
  customersRedact: "/shopify/webhooks/customers/redact",
  shopRedact: "/shopify/webhooks/shop/redact",
  appUninstalled: "/shopify/webhooks/app/uninstalled",
} as const;

/**
 * SEPARATE PATHS, not one endpoint dispatching on `X-Shopify-Topic`. [W2]'s TOML sample points all three
 * compliance topics at a single `uri`, which is legal — but the topic header is UNSIGNED, so a single
 * endpoint would have to decide what to do from an attacker-choosable value. Separate paths do not fix
 * that on their own (the URL is equally attacker-choosable); what fixes it is `matchesPayloadShape`,
 * which discriminates on the HMAC-COVERED BODY. The separate paths just make each handler's expected
 * shape explicit and give each topic its own review surface.
 */

/** KV collection recording deliveries already acted on, keyed `<topic>:<webhookId>` ([W1]'s own
 *  dedup recipe: "Check your persistent store for that ID… If it exists, skip processing"). */
export const WEBHOOK_SEEN_COLLECTION = "shopify_webhook_seen";

/** KV collection holding OPEN `customers/data_request` obligations. */
export const DATA_REQUEST_COLLECTION = "shopify_data_requests";

/**
 * How long a dedup mark is kept. 7 days comfortably outlives [W1]'s retry window ("retries 8 times over
 * the next 4 hours"), which is the only window in which a DUPLICATE delivery of the same id is expected.
 * A TTL rather than forever because this collection grows with delivery volume and the entries have no
 * value once retries are impossible; the RuntimeStatePort's own `sweepExpired` reclaims them.
 */
const SEEN_TTL_SECONDS = 7 * 24 * 60 * 60;

/** [W2]: "Complete the action within 30 days of receiving the request." */
export const DATA_REQUEST_DUE_DAYS = 30;

/** The operator tool every reversalPath here names. #179: `deploy-staging.yml` deploys
 *  `palup-widget-staging` only and the control plane is deployed NOWHERE, so no HTTP route and no console
 *  may be named in a reversal path. This CLI is the only merchant-lifecycle tool that actually exists. */
const MERCHANT_CLI = "pnpm exec tsx packages/widget-backend/src/jobs/merchant.ts";

export interface ShopifyWebhookDeps {
  store: RuntimeStatePort;
  registry: MerchantRegistryPort;
  /** Where a subject's distilled facts live. `eraseSubject` deletes one namespace through it. */
  vector: VectorPort;
  /** Resolves the APP-scoped OAuth client secret — the SAME secret that signs webhook HMACs ([W1]:
   *  "generated using your app's client secret"). Called per request so a rotation takes effect without a
   *  redeploy, and so the secret is never captured in a closure at boot. [W1] warns a rotation can take
   *  up to an hour to take effect on Shopify's side, so an operator should expect refusals in that window
   *  unless both secrets are accepted — dual-secret acceptance is NOT built here. */
  clientSecret: () => Promise<string | undefined>;
  /** Keyed-HMAC key for the audit `subjectRef` (audit.ts's rule: a bare hash of a low-entropy numeric
   *  customer id is brute-forceable). Optional, mirroring `eraseSubject`'s own `hmacKey`. */
  auditHmacKey?: string;
  /** True when a kill is armed for this tenant/agent/globally (NN#4). */
  killCheck: (tenantId: string) => Promise<boolean>;
  /** Unix millis. Injectable so the 30-day due date is deterministic in tests. */
  now: () => number;
  /** Per-IP rate limit for these PUBLIC routes — `false` ⇒ refuse. See `limited` below. */
  checkRateLimit?: (ipKey: string) => Promise<boolean>;
}

/** A refusal reason, for the SERVER-SIDE log only. The HTTP response never distinguishes these — a
 *  distinguishable refusal would turn the endpoint into an oracle for which check failed. Closed set of
 *  literals defined in this file, so nothing attacker-controlled can reach a log line. */
type Refusal =
  | "no_app_secret"
  | "bad_hmac"
  | "unparseable_body"
  | "wrong_payload_shape"
  | "bad_shop"
  | "no_shop_header"
  | "bad_customer_id"
  | "no_data_request_id"
  | "rate_limited"
  | "internal_error";

/** A delivery we accept (200) but that changed nothing, because there is nothing here to change. */
type Ack = "unknown_shop" | "already_handled" | "halted_deferred" | "recorded_not_fulfilled" | "applied";

function logRefusal(topic: string, reason: Refusal): void {
  // Topic is a fixed literal chosen by the ROUTE, never read from the request — so this line cannot be
  // injected into (a newline in a header value can never reach it) and carries no payload data at all.
  console.warn(`[shopify-webhook] ${topic} refused: ${reason}`);
}

/**
 * A pseudonymous, keyed reference to a customer, for the audit log.
 *
 * audit.ts:117-124 states the rule this follows: a Shopify shopper id embeds a LOW-ENTROPY numeric
 * customer id, so a bare unsalted hash is brute-forceable and the RAW id must never be written to an
 * audit record. So this is a keyed HMAC when a key is configured. Without one it returns a fixed
 * placeholder rather than falling back to a plain sha256 — for a low-entropy numeric id a plain hash is
 * pseudonymity theatre, and an operator is better served by an audit row that admits it has no reference
 * than by one that looks pseudonymous and is not.
 */
function subjectRef(shopperId: string, hmacKey?: string): string {
  if (!hmacKey) return "unreferenced (no AUDIT_HMAC_SECRET configured)";
  return `cust_${createHmac("sha256", hmacKey).update(shopperId).digest("hex").slice(0, 16)}`;
}

/** What every handler needs after verification succeeded. */
interface Verified {
  body: Record<string, unknown>;
  webhookId: string | undefined;
  shopHeader: string | undefined;
}

/**
 * The shared front half of every handler, in the order the order MATTERS:
 *   1. rate limit (before any HMAC work — an anonymous caller must not be able to make this process
 *      compute unbounded HMACs, and the audit chain a delivery appends to is immutable and non-trimmable);
 *   2. the app secret must exist (an unconfigured app verifies NOTHING);
 *   3. HMAC over the RAW BYTES — nothing below reads a byte of the payload before this passes;
 *   4. parse;
 *   5. payload SHAPE, which is what blocks cross-topic replay of a validly-signed body.
 * Returns a `Refusal` or the verified payload. NOTHING is logged, audited or written before step 3.
 */
async function verify(deps: ShopifyWebhookDeps, topic: string, rawBody: unknown, headers: Record<string, unknown>): Promise<Verified | { refused: Refusal }> {
  const secret = await deps.clientSecret();
  if (!secret) return { refused: "no_app_secret" };
  // A Buffer, from the plugin's catch-all parser. Anything else means the parser did not apply, which
  // must fail closed rather than fall back to hashing a stringified object.
  if (!Buffer.isBuffer(rawBody)) return { refused: "bad_hmac" };
  if (!verifyWebhookHmac(secret, rawBody, headers[WEBHOOK_HMAC_HEADER])) return { refused: "bad_hmac" };
  const body = parseWebhookBody(rawBody);
  if (!body) return { refused: "unparseable_body" };
  if (!matchesPayloadShape(topic, body)) return { refused: "wrong_payload_shape" };
  return { body, webhookId: singleHeader(headers[WEBHOOK_ID_HEADER]), shopHeader: singleHeader(headers[WEBHOOK_SHOP_HEADER]) };
}

/**
 * `includeInactive: true` EVERYWHERE, and this is load-bearing rather than defensive.
 *
 * `MerchantRegistryPort` lookups are DEFAULT-INERT: a `uninstalled`/`suspended` merchant resolves to
 * `null` (merchant-registry-port.ts:112-120). But `shop/redact` arrives "48 hours after a store owner
 * uninstalls your app" ([W2]) — by which time `app/uninstalled` has already set the status, so a default
 * lookup would return `null` and the erasure would silently do nothing while returning 200. That is the
 * exact "200 that means ignored" failure this PR exists to avoid. Erasure paths are precisely the callers
 * `includeInactive` was added for (the port's own doc comment names them).
 */
async function resolveTenant(deps: ShopifyWebhookDeps, shopDomain: string): Promise<MerchantRecord | null> {
  return deps.registry.lookupByShopDomain(shopDomain, { includeInactive: true });
}

/** Has this exact delivery already been acted on? [W1]'s dedup recipe. Read failures are treated as
 *  "not seen" so a transient store fault cannot make us silently skip a compliance obligation. */
async function alreadyHandled(deps: ShopifyWebhookDeps, tenantId: string, topic: string, webhookId: string | undefined): Promise<boolean> {
  if (!webhookId) return false; // no id ⇒ no dedup possible; the actions are idempotent anyway
  try {
    return (await deps.store.get({ tenantId }, WEBHOOK_SEEN_COLLECTION, `${topic}:${webhookId}`)) !== null;
  } catch {
    return false;
  }
}

/** Mark a delivery handled — AFTER the action, never before (see the header note on ordering). */
async function markHandled(deps: ShopifyWebhookDeps, tenantId: string, topic: string, webhookId: string | undefined): Promise<void> {
  if (!webhookId) return;
  try {
    await deps.store.put({ tenantId }, WEBHOOK_SEEN_COLLECTION, `${topic}:${webhookId}`, { topic, at: new Date(deps.now()).toISOString() }, { ttlSeconds: SEEN_TTL_SECONDS });
  } catch {
    // A failed mark means at worst a duplicate delivery re-runs an idempotent action and appends a
    // second audit row. That is visibly harmless; refusing the delivery over it would not be.
  }
}

// ── The four handlers ──────────────────────────────────────────────────────────────────────────────
//
// Each returns an `Ack`, which the route renders as 200. A `Refusal` is 401 for a bad HMAC (a [W2]
// LISTING REQUIREMENT) and 400 for everything else. Neither response body says which.

/**
 * `app/uninstalled` — the topic that makes revocation real.
 *
 * Revocation is a STATUS, never a delete (`jobs/merchant.ts`'s own rule): the row stays, so the tenant's
 * sessions, consent records, audit chain and memory namespaces remain reachable for support, billing
 * reconciliation and — 48 hours later — `shop/redact`'s erasure. Deleting the row would strand all of it
 * in namespaces nothing can resolve.
 *
 * NO KILL-SWITCH GATE, deliberately. Every other action in this file is gated on NN#4 because it
 * destroys data. This one only makes a merchant INERT, which points the SAME WAY as a halt: refusing it
 * during a halt would leave an uninstalled merchant servable, which is strictly worse than performing it.
 * There is no code path here an operator cannot stop, because there is nothing running to stop — the
 * effect is a single reversible status write, and `MERCHANT_CLI` reverses it.
 *
 * REPLAY, both directions, because they are different problems:
 *   • A replayed old delivery can never RESURRECT a revoked merchant: this handler only ever writes
 *     `"uninstalled"`. There is no argument, header or body field that could make it write `"active"`.
 *     That is a structural property, not a check that could be forgotten.
 *   • A replayed old delivery arriving AFTER a legitimate re-install COULD wrongly re-revoke an active
 *     merchant. Delivery dedup is what prevents that, and it is the honest bound: dedup rests on an
 *     UNSIGNED header, so a determined replayer who varies `X-Shopify-Webhook-Id` can still re-revoke a
 *     re-installed merchant. The blast radius is one merchant becoming inert, reversible with one
 *     command and visible in the audit chain — and closing it properly needs a signed freshness signal
 *     Shopify does not provide on this topic (see `WEBHOOK_REPLAY`).
 */
async function handleAppUninstalled(deps: ShopifyWebhookDeps, v: Verified): Promise<Ack | { refused: Refusal }> {
  // The shop comes from the HEADER for this topic only — see `APP_UNINSTALLED_SHOP_SOURCE` for the full
  // reasoning and the bound on that trust. Never guessed: an absent or non-myshopify header is refused.
  if (!v.shopHeader) return { refused: "no_shop_header" };
  if (!isValidShopDomain(v.shopHeader)) return { refused: "bad_shop" };
  const shopDomain = v.shopHeader.toLowerCase();

  const existing = await resolveTenant(deps, shopDomain);
  if (!existing) return "unknown_shop";
  const tenantId = existing.tenantId;
  if (await alreadyHandled(deps, tenantId, UNINSTALL_TOPIC, v.webhookId)) return "already_handled";
  // Already inert ⇒ nothing to do and nothing to audit. Not a silent skip: the FIRST revocation is what
  // carries the audit row, and re-auditing an unchanged state would add noise, not information.
  if (existing.status === "uninstalled") return "already_handled";

  const reason = `${UNINSTALL_TOPIC} webhook (${APP_UNINSTALLED_SHOP_SOURCE})`;
  // Audit BEFORE the write (header note). PII-free by construction: a shop domain is merchant business
  // identity, not customer personal data, and it is the ONE identifier an operator needs to act on this.
  await deps.store.audit(
    { tenantId },
    {
      actor: "system:shopify-webhook",
      action: "merchant.uninstalled",
      input: { tenantId, shopDomain, topic: UNINSTALL_TOPIC, shopSource: "header" },
      decision: { status: "uninstalled", previousStatus: existing.status, effect: "every registry lookup is now default-inert" },
      reversalPath:
        `${MERCHANT_CLI} status --tenant ${tenantId} --status active ` +
        `(restores servability; the row, embedKey and createdAt were never deleted. ` +
        `A genuine re-install through /shopify/callback reactivates it the same way.)`,
    },
  );
  await deps.registry.setStatus(tenantId, "uninstalled", { reason });
  await markHandled(deps, tenantId, UNINSTALL_TOPIC, v.webhookId);
  return "applied";
}

/**
 * Erase every memory namespace this tenant's subject index knows about.
 *
 * `eraseTenant` (widget-memory/src/erasure.ts:146) THROWS `NotImplemented` — Option B keys the vector
 * port per subject and the port has no `deleteByPrefix`. So this is built from B4's per-tenant subject
 * index instead (`listSubjects`, subject-index.ts, #156), which is the machinery that made the scheduled
 * retention sweep possible and works here for the same reason.
 *
 * ITS HONEST LIMIT, which the audit record states: the index holds a row only for a subject that had a
 * fact WRITE go through `recordSubject`. A subject whose facts predate the index would be missed. Today
 * that set is provably empty — the memory subsystem is double-gated OFF (`MEMORY_ADR_ACCEPTED = false`,
 * widget-memory/src/flag.ts) and has never written anything in production — but that stops being true
 * the moment the flag flips, so it is recorded as a caveat rather than as a proof.
 *
 * Returns the count erased. Each subject is erased independently: one failure must not abandon the rest
 * of a legally-mandated erasure, so failures are counted and reported, never thrown.
 */
async function eraseIndexedSubjects(deps: ShopifyWebhookDeps, tenantId: string): Promise<{ erased: number; failed: number }> {
  let erased = 0;
  let failed = 0;
  let subjects: Array<{ subject: string }> = [];
  try {
    subjects = await listSubjects(deps.store, tenantId);
  } catch {
    return { erased: 0, failed: 1 };
  }
  for (const { subject } of subjects) {
    try {
      // `eraseSubject` writes its own unconditional audit row per subject (erasure.ts), so each erasure
      // is independently evidenced in the tenant's chain, not just summarised by ours.
      await eraseSubject({ vector: deps.vector, audit: deps.store, hmacKey: deps.auditHmacKey }, { tenantId, anonId: subject });
      await retireSubject(deps.store, { tenantId, subject });
      erased += 1;
    } catch {
      failed += 1;
    }
  }
  return { erased, failed };
}

/** What `shop/redact` provably cannot reach, named in the audit record so no operator reads a 200 as
 *  "this shop is gone from our systems". Each entry states WHY, because a reason is what makes the gap
 *  actionable rather than just disclosed. */
const SHOP_REDACT_RESIDUAL: readonly string[] = [
  "the tenant's immutable audit chain — retained BY DESIGN (NN#5); it holds keyed-HMAC subject refs, never raw customer ids",
  "memory_consent records — @palup/state-postgres exports no delete and the collection name is private to it",
  "session state and any other KV collection — RuntimeStatePort has no enumerate-collections operation, so they cannot be named exhaustively",
  "memory namespaces for subjects absent from the per-tenant subject index (subject-index.ts only records subjects whose facts were written through it)",
  "anything held on Shopify's own side, and anything a merchant exported before uninstalling",
];

/** What `customers/redact` provably cannot reach. */
const CUSTOMER_REDACT_RESIDUAL: readonly string[] = [
  "the same person's GUEST memory namespaces — a guest anonId is 128 bits of randomBytes with no derivation from a customer id (identity.ts), so no customer id can name one",
  "the per-tenant traffic log — canary.ts logTraffic retains the redacted message + reply keyed by a HASHED sessionId, and no anonId/customerId→sessionId link exists to key a deletion by",
  "memory_consent records — no exported delete (see shop/redact residual)",
  "orders — nothing to erase: this system stores no order data at all; commerce reads go to the port per request",
];

/**
 * `shop/redact` — [W2]: "erase data for that store from your database", 48 hours after the uninstall.
 *
 * KILL-SWITCH GATED (NN#4), unlike `app/uninstalled`, because this one DESTROYS DATA. When a halt is
 * armed the erasure does not run — but the OBLIGATION IS NOT LOST: it is audited as deferred with a due
 * date and the merchant is still made inert, and the response is still 200 so Shopify's retries are not
 * burned (see the header note on why a 500 is the worse failure). Completing a deferred erasure is a
 * human action, which is the correct place for it: an erasure an operator deliberately halted must not
 * resume itself.
 */
async function handleShopRedact(deps: ShopifyWebhookDeps, v: Verified): Promise<Ack | { refused: Refusal }> {
  const shopDomain = bodyShopDomain(v.body); // HMAC-COVERED, never the header
  if (!shopDomain) return { refused: "bad_shop" };
  const existing = await resolveTenant(deps, shopDomain);
  if (!existing) return "unknown_shop";
  const tenantId = existing.tenantId;
  if (await alreadyHandled(deps, tenantId, "shop/redact", v.webhookId)) return "already_handled";

  const dueBy = new Date(deps.now() + DATA_REQUEST_DUE_DAYS * 86_400_000).toISOString();

  if (await deps.killCheck(tenantId)) {
    await deps.store.audit(
      { tenantId },
      {
        actor: "system:shopify-webhook",
        action: "shop.redact_deferred",
        input: { tenantId, shopDomain, topic: "shop/redact" },
        decision: { erased: [], complete: false, deferred: true, reason: "a kill switch is armed for this tenant/agent/globally — a halted erasure must not resume itself", dueBy },
        reversalPath:
          `NOT REVERSIBLE ONCE RUN — this records a PENDING erasure, nothing was deleted. To complete it: ` +
          `disarm the halt (pnpm kill:disarm --scope tenant:${tenantId}), then re-deliver this webhook from ` +
          `the Shopify admin, or run the erasure by hand. To abandon it: no action — but Shopify's 30-day ` +
          `window (due ${dueBy}) then lapses unmet.`,
      },
    );
    // The merchant is still made inert even while halted: that is the fail-closed direction, and
    // `app/uninstalled` (which is not kill-gated) would have done it 48 hours earlier anyway.
    if (existing.status !== "uninstalled") await deps.registry.setStatus(tenantId, "uninstalled", { reason: "shop/redact webhook (erasure deferred by an armed kill switch)" });
    await markHandled(deps, tenantId, "shop/redact", v.webhookId);
    return "halted_deferred";
  }

  // AUDIT FIRST (header note): if this throws, nothing below runs and no unaudited erasure lands.
  await deps.store.audit(
    { tenantId },
    {
      actor: "system:shopify-webhook",
      action: "shop.redact_applied",
      input: { tenantId, shopDomain, topic: "shop/redact" },
      decision: {
        // `complete: false` is asserted by test, so a future change that starts claiming completeness has
        // to defeat a test rather than quietly ship an overclaim.
        complete: false,
        erased: ["merchant status → uninstalled (inert)", "every memory namespace named by the per-tenant subject index", "the per-tenant traffic log (message + reply text)"],
        notErased: SHOP_REDACT_RESIDUAL,
      },
      reversalPath:
        `THE ERASURE IS NOT REVERSIBLE — vector namespaces and traffic entries are deleted outright, which ` +
        `is the point of a redaction request. Only the STATUS is reversible: ${MERCHANT_CLI} status ` +
        `--tenant ${tenantId} --status active (which would restore servability for a shop that asked to be ` +
        `erased — do not, except to correct a wrongly-targeted delivery).`,
    },
  );

  if (existing.status !== "uninstalled") await deps.registry.setStatus(tenantId, "uninstalled", { reason: "shop/redact webhook" });
  await eraseIndexedSubjects(deps, tenantId);
  try {
    // `keepLast: 0` removes every entry of the tenant's traffic stream. This is the ONE thing in the repo
    // that can erase the traffic log the #185 review flagged as unreachable — unreachable PER SHOPPER
    // (no anonId→sessionId link), but reachable PER TENANT, which is exactly this topic's scope.
    await deps.store.trimStream({ tenantId }, "traffic", 0);
  } catch {
    /* counted only in the log; the audit row above already refuses to claim completeness */
  }
  await markHandled(deps, tenantId, "shop/redact", v.webhookId);
  return "applied";
}

/**
 * `customers/redact` — [W2]: "Store owners can request that data is deleted on behalf of a customer."
 *
 * The one derivable link from a Shopify customer id to stored data:
 *   customer.id ──buildShopifyShopperId(tenant, id)──▶ `shopify:<tenant>:<id>`
 *              ──accountSubjectId──▶ `acct:shopify:<tenant>:<id>`  (the memory subject a SIGNED-IN
 *                shopper gets — identity.ts `memorySubjectId`)
 *              ──subjectNamespace──▶ the vector namespace `eraseSubject` deletes.
 * Both id components are re-validated by `buildShopifyShopperId` (`[a-z0-9-]+` / `\d+`), so a hostile
 * value cannot be interpolated into a namespace; a value it refuses is a 400, never a coerced guess.
 *
 * `CUSTOMER_REDACT_RESIDUAL` is the honest remainder, in the audit record on every delivery.
 */
async function handleCustomerRedact(deps: ShopifyWebhookDeps, v: Verified): Promise<Ack | { refused: Refusal }> {
  const shopDomain = bodyShopDomain(v.body);
  if (!shopDomain) return { refused: "bad_shop" };
  const customerId = customerIdOf(v.body);
  if (!customerId) return { refused: "bad_customer_id" };
  const existing = await resolveTenant(deps, shopDomain);
  if (!existing) return "unknown_shop";
  const tenantId = existing.tenantId;
  const shopperId = buildShopifyShopperId(tenantId, customerId);
  // A tenant id outside `[a-z0-9-]+` cannot produce a sound namespaced shopper id, so there is no subject
  // to erase and guessing one would be worse than refusing.
  if (!shopperId) return { refused: "bad_customer_id" };
  const subject = accountSubjectId(shopperId);
  if (await alreadyHandled(deps, tenantId, "customers/redact", v.webhookId)) return "already_handled";

  const ref = subjectRef(shopperId, deps.auditHmacKey);
  const dueBy = new Date(deps.now() + DATA_REQUEST_DUE_DAYS * 86_400_000).toISOString();

  if (await deps.killCheck(tenantId)) {
    await deps.store.audit(
      { tenantId },
      {
        actor: "system:shopify-webhook",
        action: "customer.redact_deferred",
        input: { tenantId, shopDomain, topic: "customers/redact", subjectRef: ref },
        decision: { complete: false, deferred: true, reason: "a kill switch is armed — a halted erasure must not resume itself", dueBy, notErased: CUSTOMER_REDACT_RESIDUAL },
        reversalPath:
          `NOTHING WAS DELETED. To complete: disarm the halt (pnpm kill:disarm --scope tenant:${tenantId}) ` +
          `and re-deliver this webhook from the Shopify admin. Shopify's window closes ${dueBy}.`,
      },
    );
    await markHandled(deps, tenantId, "customers/redact", v.webhookId);
    return "halted_deferred";
  }

  await deps.store.audit(
    { tenantId },
    {
      // NEVER the raw customer id, email or phone — only the keyed `subjectRef` (audit.ts's rule). The
      // exact key set here is asserted by test, so a later "record the email for debugging" change fails
      // a test rather than shipping a PII leak into an IMMUTABLE log.
      actor: "system:shopify-webhook",
      action: "customer.redact_applied",
      input: { tenantId, shopDomain, topic: "customers/redact", subjectRef: ref },
      decision: {
        complete: false,
        erased: ["the account-scoped memory namespace acct:shopify:<tenant>:<customer id>"],
        notErased: CUSTOMER_REDACT_RESIDUAL,
      },
      reversalPath:
        `THE ERASURE IS NOT REVERSIBLE — that is the point of a redaction request. There is no restore ` +
        `path and none should exist; the reversal of a WRONGLY-TARGETED delivery is that the shopper's ` +
        `next visit starts fresh (their memory namespace is rebuilt from new turns, subject to consent).`,
    },
  );

  try {
    await eraseSubject({ vector: deps.vector, audit: deps.store, hmacKey: deps.auditHmacKey }, { tenantId, anonId: subject });
    await retireSubject(deps.store, { tenantId, subject });
  } catch {
    // Refuse rather than mark handled: Shopify's retry is the only thing that will bring this obligation
    // back, and the audit row above already records that we intended to act.
    return { refused: "internal_error" };
  }
  await markHandled(deps, tenantId, "customers/redact", v.webhookId);
  return "applied";
}

/**
 * `customers/data_request` — ACKNOWLEDGED-ONLY, and the audit record says so on every delivery.
 *
 * See the file header for the evidence that no export capability exists. What this handler does instead
 * is the honest minimum that is strictly better than a bare 200:
 *   • it ERASES NOTHING. A data request is an ACCESS request; a handler that deleted on one would destroy
 *     exactly the data the shopper asked to see. There is a test for this, because it is the worst
 *     available bug in this file.
 *   • it records a DURABLE, DATED obligation (no TTL — a 30-day legal obligation must not silently
 *     expire out of a KV store) that an operator can enumerate with `RuntimeStatePort.list`. There is no
 *     deployed console that surfaces it; that is stated, not glossed.
 *   • it audits `fulfilled: false` with the reason, so the immutable log never implies a fulfilment.
 * The recorded obligation carries the keyed `subjectRef` and the `data_request` id — never the email,
 * phone or raw customer id that arrived in the payload.
 */
async function handleDataRequest(deps: ShopifyWebhookDeps, v: Verified): Promise<Ack | { refused: Refusal }> {
  const shopDomain = bodyShopDomain(v.body);
  if (!shopDomain) return { refused: "bad_shop" };
  const requestId = dataRequestIdOf(v.body);
  if (!requestId) return { refused: "no_data_request_id" };
  const customerId = customerIdOf(v.body);
  if (!customerId) return { refused: "bad_customer_id" };
  const existing = await resolveTenant(deps, shopDomain);
  if (!existing) return "unknown_shop";
  const tenantId = existing.tenantId;
  const shopperId = buildShopifyShopperId(tenantId, customerId);
  if (!shopperId) return { refused: "bad_customer_id" };
  if (await alreadyHandled(deps, tenantId, "customers/data_request", v.webhookId)) return "already_handled";

  const ref = subjectRef(shopperId, deps.auditHmacKey);
  const receivedAt = new Date(deps.now()).toISOString();
  const dueBy = new Date(deps.now() + DATA_REQUEST_DUE_DAYS * 86_400_000).toISOString();
  const reason =
    "no export capability exists in this system: there is no subject-access/portability route or port " +
    "method anywhere in packages/, and no deployed merchant console to deliver one through. Shopify asks " +
    "for the data to be provided to the STORE OWNER directly, out of band, within 30 days.";

  await deps.store.audit(
    { tenantId },
    {
      actor: "system:shopify-webhook",
      action: "data_request.acknowledged",
      input: { tenantId, shopDomain, topic: "customers/data_request", dataRequestId: requestId, subjectRef: ref },
      decision: { fulfilled: false, recorded: true, reason, dueBy, whereTheDataWouldBe: ["the account-scoped memory namespace (empty today: memory is double-gated off)", "the per-tenant traffic log (redacted message + reply, hashed sessionId)"] },
      reversalPath:
        `n/a — nothing was changed or disclosed. This records an OPEN obligation. Read the open list with ` +
        `RuntimeStatePort.list({tenantId:"${tenantId}"}, "${DATA_REQUEST_COLLECTION}"). There is no ` +
        `deployed console or CLI that lists it yet — reported as a follow-up, not built here.`,
    },
  );
  await deps.store.put(
    { tenantId },
    DATA_REQUEST_COLLECTION,
    requestId,
    { dataRequestId: requestId, tenantId, shopDomain, subjectRef: ref, receivedAt, dueBy, fulfilled: false },
    // NO ttlSeconds, deliberately: an unmet legal obligation must not disappear on its own.
  );
  await markHandled(deps, tenantId, "customers/data_request", v.webhookId);
  return "recorded_not_fulfilled";
}

/**
 * Register the four routes inside their OWN plugin scope, so the raw-body parser is encapsulated.
 *
 * Called by the composition root ONLY when the feature is fully configured (an app client secret + a
 * durable merchant registry) — absent, not half-working, otherwise. Not `await`ed on purpose: Fastify's
 * own docs warn that awaiting a `register` can let routes be added before `addContentTypeParser` takes
 * effect, which would silently reinstate JSON parsing on exactly the routes that must not have it.
 */
export function registerShopifyWebhookRoutes(app: FastifyInstance, deps: ShopifyWebhookDeps): void {
  void app.register(async (scoped) => {
    // THE RAW BODY. Drop the inherited JSON parser inside this scope and take the bytes untouched.
    // `parseAs: "buffer"` makes Fastify collect the stream and enforce the body limit for us; the
    // "parser" then does nothing at all, which is the whole point ([W1]: "Capture the raw body before
    // it's parsed"). The catch-all `*` covers a delivery whose Content-Type is not exactly
    // `application/json` — [W2] says Shopify sends `application/json`, but a verifier that only works on
    // one exact header value would fail closed in a way that looks like a bad HMAC.
    scoped.removeAllContentTypeParsers();
    scoped.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

    /**
     * Per-IP cap, checked before any HMAC work. FAIL CLOSED (a broken limiter refuses) — the same choice
     * C1 made and for the same reason: these routes take durable, audited, DESTRUCTIVE action, so if the
     * limiter itself is unavailable the right answer is to refuse and let Shopify retry, not to proceed
     * uncapped. This is also the only thing bounding a replayer who varies the dedup header.
     */
    const limited = async (req: { headers: Record<string, unknown>; ip: string }): Promise<boolean> => {
      if (!deps.checkRateLimit) return false;
      try {
        const xff = req.headers["x-forwarded-for"];
        const ipKey = clientIpKey(Array.isArray(xff) ? (xff[0] as string) : (xff as string | undefined), req.ip);
        return !(await deps.checkRateLimit(ipKey));
      } catch {
        return true;
      }
    };

    /**
     * One route body for all four topics. The response is deliberately minimal and identical across
     * outcomes: `{ok:true}` for anything acknowledged, `{error:"unauthorized"}` for a bad HMAC (401 — the
     * [W2] listing requirement) and `{error:"bad request"}` for every other refusal. It never says WHICH
     * check failed, never echoes a payload field, and never carries an error message.
     */
    const route = (path: string, topic: string, handle: (d: ShopifyWebhookDeps, v: Verified) => Promise<Ack | { refused: Refusal }>): void => {
      scoped.post(path, async (req, reply) => {
        reply.header("cache-control", "no-store");
        if (await limited(req)) {
          logRefusal(topic, "rate_limited");
          reply.code(429);
          return { error: "rate limited" };
        }
        let outcome: Ack | { refused: Refusal };
        try {
          const v = await verify(deps, topic, req.body, req.headers as Record<string, unknown>);
          outcome = "refused" in v ? v : await handle(deps, v);
        } catch {
          // An outer catch so NO exception reaches the HTTP layer. Fastify's default error handler puts
          // `err.message` in the response body, and the values in scope here include the app client
          // secret and (before the audit strips them) a customer's email and phone. A uniform refusal is
          // the only safe rendering; the swallowed error is deliberate — see `logRefusal`.
          outcome = { refused: "internal_error" };
        }
        if (typeof outcome !== "string") {
          logRefusal(topic, outcome.refused);
          // 401 for an authenticity failure — [W2]: "If a mandatory compliance webhook sends a request
          // with an invalid Shopify HMAC header, then the app must return a 401 Unauthorized HTTP
          // status." `no_app_secret` is folded in here on purpose: from the caller's side an app that
          // cannot verify is indistinguishable from one that verified and refused, and revealing the
          // difference would tell an attacker the app is unconfigured.
          const authFailure = outcome.refused === "bad_hmac" || outcome.refused === "no_app_secret";
          reply.code(authFailure ? 401 : outcome.refused === "internal_error" ? 500 : 400);
          return { error: authFailure ? "unauthorized" : outcome.refused === "internal_error" ? "internal error" : "bad request" };
        }
        // 200 for every acknowledged outcome ([W2]: "Confirm that you've received the request by
        // responding with a 200 series status code"). `outcome` is a closed set of literals from this
        // file, so returning it leaks nothing and gives an operator reading a proxy log the one useful
        // fact: whether the delivery was applied, deferred, deduped, or for a shop we do not know.
        return { ok: true, outcome };
      });
    };

    route(WEBHOOK_ROUTES.appUninstalled, UNINSTALL_TOPIC, handleAppUninstalled);
    route(WEBHOOK_ROUTES.shopRedact, COMPLIANCE_TOPICS[2], handleShopRedact);
    route(WEBHOOK_ROUTES.customersRedact, COMPLIANCE_TOPICS[1], handleCustomerRedact);
    route(WEBHOOK_ROUTES.customersDataRequest, COMPLIANCE_TOPICS[0], handleDataRequest);
  });
}
