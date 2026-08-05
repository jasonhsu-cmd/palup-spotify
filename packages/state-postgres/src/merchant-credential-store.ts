import type { CryptoPort, RuntimeStatePort } from "@palup/platform-ports";

// B2 — per-merchant custody of a COMMERCE DELEGATE CREDENTIAL (in Shopify terms: the Storefront/delegate
// access token a merchant's install grants us), encrypted at rest. Built ENTIRELY on two EXISTING ports —
// `CryptoPort` for the encryption and `RuntimeStatePort` for the durable, tenant-scoped row + the atomic
// audit — so there is no new port surface, no new table, and no vendor SDK anywhere near it (ADR-0001,
// CLAUDE.md §3.3). Like `runtime-consent-store.ts`, this file lives in `state-postgres` for company but is
// ENGINE-AGNOSTIC: it works on any `RuntimeStatePort`, and its tests run it on both adapters.
//
// NOTHING CALLS THIS YET, and that is written here rather than only in a PR body. Production still reads a
// merchant's Storefront token straight from `SecretsPort` (`widget-backend/src/merchant-store.ts:16,47` —
// `SHOPIFY_TOKEN_SECRET`), which is where an operator provisions it by hand today. This store is INERT
// until C1 (the OAuth install/uninstall routes) both obtains a delegate token and reads it back from here.
// Do not read this file as "delegate-token custody is handled now"; read it as "the custody for it exists".
// Deliberately NOT included, following B1's lead: no env-driven factory, no `ready()` probe, no rotation
// job, no second credential kind — a convenience with no caller is one more piece of unreachable
// machinery, and C1 is the change that gets to decide the composition.
//
// WHY `rs_kv` AND NOT A COLUMN ON `pl_merchant`: `pl_merchant` (B1) is the merchant IDENTITY table and its
// column set is asserted as an exact allowlist precisely so a token can never be stashed there
// (postgres-merchant-registry.ts:63-68). A credential belongs behind encryption in the tenant-scoped KV,
// where every statement carries a `tenant_id` predicate and a blank tenant is refused outright
// (postgres-runtime-store.ts:20-24), and where the audit chain that must record the write can commit in
// the same transaction.
//
// TWO INDEPENDENT ISOLATION MECHANISMS, ON PURPOSE (belt and braces — neither alone is enough):
//   1. `RuntimeStatePort`'s `{ tenantId }` scoping keeps merchant B's reads off merchant A's ROW. That is
//      an ACCESS-PATH guarantee: it holds for anything going through the port, and stops nothing that
//      reaches the table another way (a support script, a migration, a compromised DBA, a future adapter
//      bug). A copied row would be served happily.
//   2. `CryptoPort`'s per-(tenant, scope) key makes the CIPHERTEXT ITSELF unreadable outside its merchant:
//      the key material is looked up per tenant AND the tenantId is mixed into HKDF's `info`
//      (crypto-port.ts:161-173), and the aad below binds the ciphertext to this collection + tenant + row.
//      So the relocated-row case above decrypts to nothing rather than to another merchant's token.
// The test suite asserts BOTH: the plain tenant-scoped miss, and a verbatim row copy into another tenant.
//
// THE KEY SCOPE, and an honest note on what "per-merchant" means here. `keyScope` (crypto-port.ts:20-36)
// is a per-PURPOSE label, not a per-merchant one: it selects WHICH of a tenant's keys to use and is bound
// into the GCM aad. The per-merchant dimension is already the port's `tenantId` — one merchant, one key,
// derived from that merchant's own secret. So this store passes ONE explicit scope constant
// (`MERCHANT_CRED_KEY_SCOPE`) and gets the per-merchant key from the tenant argument. Putting a merchant
// id INSIDE the scope label was considered and rejected: the label may only be `[a-z0-9-]`
// (crypto-port.ts:116) so most tenant ids could not even be expressed, and it would demand one secret name
// per merchant per scope to say what the tenant dimension already says. What the explicit scope buys is
// the thing the scope work was built for: a compromise of `MEMORY_ENCRYPTION_KEY` does NOT expose stored
// merchant credentials, and the two rotate independently.
//
// SECRET NAMES (an operator runbook needs these, and `docs/DEPLOY.md` documents the DEFAULT scope only —
// crypto-port.ts:223-226 says the first non-default-scope caller must extend it; that file is contended,
// so this PR REPORTS the addition instead of editing it). For a `createAesGcmCrypto(secrets)` built with
// its default base name, the key this store uses is `keyScopeSecretName("MEMORY_ENCRYPTION_KEY",
// MERCHANT_CRED_KEY_SCOPE)` = `MEMORY_ENCRYPTION_KEY__merchant-cred`, per tenant, in the same
// `PALUP_SECRETS` map; its rotation slot is that name + `_previous`. A composition root that passes
// `opts.secretName` changes the base, not the `__merchant-cred` suffix.
//
// KEY ROTATION — SUPPORTED, and no re-install needed (test: "rotates a merchant's KEY without a
// re-install"). The port's two-step convention applies unchanged to this scope: put the outgoing value at
// `<name>_previous`, the new value at `<name>`; stored rows keep decrypting through the fallback
// (crypto-port.ts:302-311) while a re-`put` re-encrypts under the new key, after which `_previous` can be
// dropped. TWO LIMITS, stated rather than implied: (a) nothing in this repo re-encrypts existing rows for
// you — a row only moves to the new key when someone calls `put` again, so the honest rotation procedure
// is "keep `_previous` until every merchant has been re-put, or forever if you never re-put"; (b) rotating
// the merchant's TOKEN (a different thing from rotating the KEY) is `put` with the new token, and only C1
// can obtain one. No rotation machinery is built here because nothing calls it.
//
// READS ARE NOT AUDITED, deliberately: a credential read happens on the hot path of every grounded turn,
// so auditing it would bury the governance chain in read noise (`customer-grant-store.ts` makes the same
// call for shopper grants). WRITES ARE audited — see `put`/`delete`. If C1 wants read-access telemetry it
// belongs in `TelemetryPort`, not in the immutable chain.

/**
 * The `CryptoPort` key scope every credential in this store is encrypted under. Non-secret, and part of
 * the stored envelope (`v2:merchant-cred:…`) — exported so an operator runbook and the tests can name the
 * exact secret this store needs, and so C1 cannot accidentally pick a different one.
 */
export const MERCHANT_CRED_KEY_SCOPE = "merchant-cred";
/** `RuntimeStatePort` KV collection holding the encrypted rows (one per merchant). Non-secret. */
export const MERCHANT_CRED_COLLECTION = "merchant_cred";
/**
 * The row key inside that collection. The collection is ALREADY tenant-scoped, so the key names WHICH
 * credential rather than whose: one merchant has exactly one delegate credential today. A second kind
 * (e.g. an admin-API token) would be a second key here — that is a change with a caller, not a parameter
 * added speculatively now.
 */
export const MERCHANT_CRED_RECORD_KEY = "storefront_delegate";

/**
 * The outcome of a read. A discriminated union, NOT `string | undefined`, because the three cases demand
 * different operator responses and this repo keeps getting bitten by an absent read that looks like a
 * valid one:
 *   - `missing`     — no credential was ever stored (or it was deleted): the merchant must (re)install.
 *   - `unreadable`  — a row IS stored and cannot be turned back into a token. NEVER treat this as
 *                     `missing`: the credential may still be perfectly good and the KEY may be what is
 *                     wrong. Silently falling back to "unconfigured" here is how a merchant ends up served
 *                     from fixtures with nothing to point at as the cause.
 *   - `found`       — the token, in memory, for immediate use. Do not log it, do not persist it elsewhere.
 */
export type MerchantCredentialRead =
  | { status: "found"; token: string }
  | { status: "missing" }
  | {
      status: "unreadable";
      /**
       * `malformed-record` — the stored doc is not the shape this store writes (hand-edited, half-written
       * by a foreign writer, wrong collection). `undecryptable` — the envelope was rejected by
       * `CryptoPort.decrypt`.
       *
       * HONEST LIMIT: `undecryptable` cannot tell you WHICH of "no key configured for this tenant/scope",
       * "the key was rotated out and `_previous` is gone", "the row was relocated from another tenant" and
       * "the ciphertext was tampered with" happened. That is the port's contract, not an oversight —
       * `decrypt` collapses every one of those to `undefined` by design (crypto-port.ts:60-73). It is a
       * real operability gap for a credential (misconfiguration is recoverable, tampering is not), and
       * this PR reports it as a port enhancement rather than probing for the difference behind the port's
       * back.
       */
      reason: "undecryptable" | "malformed-record";
    };

export interface MerchantCredentialStore {
  /**
   * Store (or replace) this merchant's delegate credential. Encrypts FIRST — if no key is configured for
   * this tenant and scope, `CryptoPort.encrypt` throws and nothing at all is written or audited, so a
   * token is never persisted in the clear (crypto-port.ts:228-233). The KV write and its audit record then
   * commit in ONE transaction (NN#5), so an unaudited credential cannot survive a mid-write failure.
   *
   * `actor` is REQUIRED and validated at runtime: it is who this entry in the immutable log is attributed
   * to (the precedent, and the reasoning, is `recordConsent`'s `source` — runtime-consent-store.ts:95-100).
   */
  put(tenantId: string, token: string, opts: { actor: string }): Promise<void>;
  /** This merchant's credential, or an honest, distinguishable refusal. Never audited, never logged. */
  read(tenantId: string): Promise<MerchantCredentialRead>;
  /** Remove this merchant's credential (uninstall / revocation). Idempotent, and audited the same way. */
  delete(tenantId: string, opts: { actor: string }): Promise<void>;
}

export interface MerchantCredentialStoreOpts {
  /** Injectable clock (ISO-8601), the same knob `PostgresMerchantRegistry` takes, so tests are exact. */
  now?: () => string;
}

/**
 * What is stored. `c` is the `CryptoPort` envelope — the ONLY place the token appears, and it appears
 * encrypted. `updatedAt` is non-secret operator forensics: it is the one thing that lets a DBA looking at
 * `rs_kv` answer "when was this credential last written" WITHOUT the store keeping any function of the
 * token itself (a fingerprint would be a token-derived value in a durable row and, if audited, in an
 * immutable log — the cheapest way to guarantee "the token never leaks" is for nothing derived from it to
 * exist outside `c`). It is deliberately not surfaced by `read`: no caller needs it yet.
 */
interface StoredCredential {
  c: string;
  updatedAt: string;
}

function requireTenantId(tenantId: string): string {
  if (typeof tenantId !== "string" || !tenantId.trim())
    throw new Error(
      "MerchantCredentialStore: a non-blank tenantId is required (a blank one is a cross-tenant wildcard)",
    );
  return tenantId;
}

/** Never echoes the value — a rejected token is still a credential (or nearly one) and must not reach a log. */
function requireToken(token: string): string {
  if (typeof token !== "string" || !token.trim())
    throw new Error(
      "MerchantCredentialStore: refusing to store a blank credential — a stored blank looks configured but " +
        "cannot authenticate anything (fail closed)",
    );
  return token;
}

function requireActor(opts: { actor: string } | undefined): string {
  const actor = opts?.actor;
  if (typeof actor !== "string" || !actor.trim())
    throw new Error(
      "MerchantCredentialStore: a non-blank `actor` is required — it attributes this write in the immutable " +
        "audit log, and an unattributable credential change is not an auditable one (NN#5)",
    );
  return actor;
}

/**
 * GCM associated data: the collection, the tenant and the row key. Binds the ciphertext to THIS row of
 * THIS merchant, so an envelope copied onto another merchant's row (or into another collection) fails
 * authentication instead of decrypting — the second of the two isolation mechanisms in the file header.
 * The tenant is in here as well as in the key derivation on purpose: the aad is what protects against a
 * relocation within a single, correctly-provisioned deployment.
 */
function credentialAad(tenantId: string): string {
  return `${MERCHANT_CRED_COLLECTION}|${tenantId}|${MERCHANT_CRED_RECORD_KEY}`;
}

/**
 * Per-merchant, encrypted-at-rest custody for a commerce delegate credential, over the two existing
 * ports. `crypto` MUST be a `CryptoPort` — the composition root builds it (today
 * `createAesGcmCrypto(secrets)`; a cloud-KMS adapter later, unchanged here). Nothing wires this yet: C1 is
 * the first caller (file header).
 */
export function createMerchantCredentialStore(
  state: RuntimeStatePort,
  crypto: CryptoPort,
  opts: MerchantCredentialStoreOpts = {},
): MerchantCredentialStore {
  const now = opts.now ?? (() => new Date().toISOString());

  return {
    async put(tenantId, token, writeOpts) {
      const tenant = requireTenantId(tenantId);
      requireToken(token);
      const actor = requireActor(writeOpts);
      // Encrypt BEFORE opening the transaction: an unconfigured key must refuse the whole operation with
      // nothing written, and the throw comes from the port with only the tenant, the secret name and the
      // scope in its message — never the token or the key material (crypto-port.ts:244-249). This function
      // adds no context of its own to that error for exactly that reason.
      const c = await crypto.encrypt(tenant, token, credentialAad(tenant), MERCHANT_CRED_KEY_SCOPE);
      const record: StoredCredential = { c, updatedAt: now() };

      await state.tx({ tenantId: tenant }, async (t) => {
        const prior = await t.get<StoredCredential>(MERCHANT_CRED_COLLECTION, MERCHANT_CRED_RECORD_KEY);
        // NO ttlSeconds, unlike customer-grant-store.ts's 30-day cap on a shopper grant: that grant is
        // short-lived and renewable, whereas a merchant's delegate credential is valid for the life of the
        // install. A credential that quietly expired would send grounding back to fixtures with no cause
        // to point at — the silent-absence failure this store is built to avoid.
        await t.put(MERCHANT_CRED_COLLECTION, MERCHANT_CRED_RECORD_KEY, record);
        await t.audit({
          actor,
          action: "credential.store",
          // PII/secret-free by construction, and asserted as an EXACT key allowlist in the tests: which
          // credential, and whether this overwrote one. Nothing derived from the token, and not the
          // ciphertext either (an envelope in an immutable log outlives the row it came from).
          input: { credential: MERCHANT_CRED_RECORD_KEY, replaced: prior !== null },
          decision: "stored",
          // #179: a reversalPath must name something that EXISTS. Nothing in this repo deploys a
          // merchant-credential endpoint or CLI (deploy-staging.yml deploys `palup-widget-staging` only,
          // and this store has no caller at all yet), so naming one would be a fabrication an operator
          // would follow. The honest reversal is the install flow plus a revocation at the provider.
          reversalPath:
            "NOT reversible in place — the previous credential is overwritten and is not retained anywhere. " +
            "To recover: re-run the merchant's app install/authorise flow, which stores a fresh credential " +
            "over this row, and revoke the outgoing credential at the commerce provider. There is no " +
            "operator endpoint or CLI for this store (nothing calls it yet).",
        });
      });
    },

    async read(tenantId) {
      const tenant = requireTenantId(tenantId);
      const row = await state.get<StoredCredential>({ tenantId: tenant }, MERCHANT_CRED_COLLECTION, MERCHANT_CRED_RECORD_KEY);
      if (row === null) return { status: "missing" };
      if (typeof row !== "object" || typeof row.c !== "string" || !row.c)
        return { status: "unreadable", reason: "malformed-record" };
      const token = await crypto.decrypt(tenant, row.c, credentialAad(tenant), MERCHANT_CRED_KEY_SCOPE);
      // `undefined` here is "a row exists and I cannot read it" — reported AS THAT, never as `missing` and
      // never by falling back to another key or another scope (the port refuses cross-scope itself:
      // crypto-port.ts:288-296).
      if (token === undefined) return { status: "unreadable", reason: "undecryptable" };
      return { status: "found", token };
    },

    async delete(tenantId, writeOpts) {
      const tenant = requireTenantId(tenantId);
      const actor = requireActor(writeOpts);
      await state.tx({ tenantId: tenant }, async (t) => {
        const prior = await t.get<StoredCredential>(MERCHANT_CRED_COLLECTION, MERCHANT_CRED_RECORD_KEY);
        await t.delete(MERCHANT_CRED_COLLECTION, MERCHANT_CRED_RECORD_KEY);
        await t.audit({
          actor,
          action: "credential.delete",
          input: { credential: MERCHANT_CRED_RECORD_KEY, existed: prior !== null },
          decision: "deleted",
          reversalPath:
            "NOT reversible — the credential existed only as ciphertext in this row and the row is gone. " +
            "To restore access: re-run the merchant's app install/authorise flow to obtain and store a new " +
            "credential. There is no operator endpoint or CLI for this store (nothing calls it yet).",
        });
      });
    },
  };
}
