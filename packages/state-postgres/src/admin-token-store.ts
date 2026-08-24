import type { CryptoPort, RuntimeStatePort } from "@palup/platform-ports";

// Task 4 (ADR-0022 condition F2) — per-shop custody of the OFFLINE SHOPIFY ADMIN TOKEN. A PARALLEL of
// `merchant-credential-store.ts` (B2) built on the SAME two existing ports (`CryptoPort` + `RuntimeStatePort`)
// — no new port surface, no new table, no vendor SDK. See that file's header for the full custody rationale
// (encrypt-before-tx, atomic write+audit, the two independent isolation mechanisms); it is not repeated here.
//
// THE ONE THING THIS FILE EXISTS TO GET RIGHT, per ADR-0022 F2: the Admin token and the storefront delegate
// token are TWO DIFFERENT CREDENTIALS with different blast radii (Admin scopes can read/write orders,
// products, customers across the shop; the delegate token is scoped to the storefront). They MUST use a
// DISTINCT `CryptoPort` key scope and a distinct AAD, so a compromise or rotation of one NEVER exposes or
// perturbs the other. Concretely: `ADMIN_CRED_KEY_SCOPE = "admin-cred"` is a different secret name
// (`keyScopeSecretName("MEMORY_ENCRYPTION_KEY", "admin-cred")`) from merchant-cred's `"merchant-cred"`, and
// `adminCredentialAad` binds to `ADMIN_CRED_COLLECTION`/`ADMIN_CRED_RECORD_KEY`, not the merchant-cred
// collection/key — so even an operator who reused the SAME raw key material for both scopes still gets two
// non-interchangeable envelopes (the aad differs), and rotating one secret name never touches the other.
//
// STORED SHAPE ADDS `expiresAt` (non-secret) for F6 (refresh): an Admin offline token line for Shopify does
// not itself expire in the OAuth sense, but this field exists so a caller (Task 5) can track whatever
// refresh/rotation cadence it establishes without a schema change. It is NOT interpreted by this store —
// `read` returns it verbatim and `put`/`refresh` store it verbatim.
//
// `refresh` IS A SEPARATE AUDITED OP from `put`, deliberately: `put` is "first custody of a token for this
// shop" (`admin_token.store`), `refresh` is "replace an existing token, typically as part of a rotation flow"
// (`admin_token.refresh`) — an operator reading the audit log wants to tell an initial install apart from a
// later rotation without inspecting `replaced`. SINGLE-FLIGHT for concurrent refreshes is NOT this store's
// job (brief, Step 3): the store performs an audited replace; a caller that needs "only one refresh in
// flight per tenant" builds that above this layer (Task 5).

/** The `CryptoPort` key scope every Admin token in this store is encrypted under. DISTINCT from
 *  `MERCHANT_CRED_KEY_SCOPE` (ADR-0022 F2) — see file header. Must match `KEY_SCOPE_RE`
 *  (`/^[a-z0-9][a-z0-9-]{0,63}$/`, crypto-port.ts) — verified for this literal. */
export const ADMIN_CRED_KEY_SCOPE = "admin-cred";
/** `RuntimeStatePort` KV collection holding the encrypted rows (one per shop). Non-secret, and DISTINCT
 *  from `MERCHANT_CRED_COLLECTION` so the two credential kinds never share a row key namespace either. */
export const ADMIN_CRED_COLLECTION = "admin_cred";
/** The row key inside that (already tenant-scoped) collection: one shop has exactly one Admin offline
 *  token today. */
export const ADMIN_CRED_RECORD_KEY = "admin_offline";

/**
 * The outcome of a read — the same three-way discriminated union as `MerchantCredentialRead`, for the
 * same reason: `missing`, `unreadable`, and `found` demand different operator responses, and an absent
 * read must never look like a valid one.
 */
export type AdminTokenRead =
  | { status: "found"; token: string; expiresAt?: string; refreshToken?: string; refreshTokenExpiresAt?: string }
  | { status: "missing" }
  | { status: "unreadable"; reason: "undecryptable" | "malformed-record" };

/**
 * Task 6 (ADR-0023) — the fields a caller supplies for a full replace of what this row custodies:
 * the access token plus, where the caller has one, the paired `refresh_token` and its own (90d) expiry.
 * `refreshToken`/`refreshTokenExpiresAt` are OPTIONAL on the type (a `put` at install-time may legitimately
 * have neither yet — a pre-schema/legacy row, F-H), but `refresh()` in practice always supplies both
 * together, because Shopify mints a fresh pair on every refresh and retires the prior one.
 */
export interface AdminTokenWrite {
  token: string;
  expiresAt?: string;
  /** Encrypted under the SAME `ADMIN_CRED_KEY_SCOPE` + AAD as `token` (F-A) — never logged, never audited. */
  refreshToken?: string;
  /** Non-secret; when the `refresh_token` (90d) lapses. */
  refreshTokenExpiresAt?: string;
}

export interface AdminTokenStore {
  /**
   * Store (or replace) this shop's Admin offline token, and — Task 6 — its paired `refresh_token` +
   * `refreshTokenExpiresAt` when the caller has them. Encrypts FIRST — an unconfigured key throws with
   * nothing written or audited, exactly like `MerchantCredentialStore.put`. `actor` is REQUIRED (NN#5).
   */
  put(
    tenantId: string,
    token: string,
    opts: { actor: string; expiresAt?: string; refreshToken?: string; refreshTokenExpiresAt?: string },
  ): Promise<void>;
  /** This shop's Admin token, or an honest, distinguishable refusal. Never audited, never logged. */
  read(tenantId: string): Promise<AdminTokenRead>;
  /**
   * Replace an existing Admin token AND its refresh_token (rotation) — Task 6 (F-B): `next` is the FULL
   * replacement state for this row; whatever this row held before (both the access token and any prior
   * refresh_token) is retained NOWHERE once this call returns — there is no partial/merge update. Same
   * encrypt-before-tx / write+audit-together discipline as `put`, but audited as `admin_token.refresh` so
   * a rotation is distinguishable from an initial install in the immutable log. Single-flight (only one
   * refresh in progress per tenant) is enforced by the CALLER, not here (file header) — this function
   * performs one audited replace.
   */
  refresh(tenantId: string, next: AdminTokenWrite, opts: { actor: string }): Promise<void>;
  /** Remove this shop's Admin token (uninstall / revocation). Idempotent, and audited the same way. */
  delete(tenantId: string, opts: { actor: string }): Promise<void>;
}

export interface AdminTokenStoreOpts {
  /** Injectable clock (ISO-8601), the same knob `MerchantCredentialStore` takes, so tests are exact. */
  now?: () => string;
}

/**
 * What is stored. `c` is the `CryptoPort` envelope for the access token — the ONLY place it appears,
 * encrypted. `rc` (Task 6, F-A) is the SAME kind of envelope for the `refresh_token`, encrypted under the
 * SAME `ADMIN_CRED_KEY_SCOPE` + AAD as `c` (see `adminCredentialAad`) — a distinct field name only so the
 * two ciphertexts (and their absence/presence) are independently inspectable, not because they use
 * different key material. `expiresAt`/`refreshTokenExpiresAt` are non-secret and caller-supplied (see file
 * header). `updatedAt` is non-secret operator forensics, exactly like `MerchantCredentialStore`'s.
 */
interface StoredAdminToken {
  c: string;
  rc?: string;
  expiresAt?: string;
  refreshTokenExpiresAt?: string;
  updatedAt: string;
}

function requireTenantId(tenantId: string): string {
  if (typeof tenantId !== "string" || !tenantId.trim())
    throw new Error(
      "AdminTokenStore: a non-blank tenantId is required (a blank one is a cross-tenant wildcard)",
    );
  return tenantId;
}

/** Never echoes the value — a rejected token is still a credential (or nearly one) and must not reach a log. */
function requireToken(token: string): string {
  if (typeof token !== "string" || !token.trim())
    throw new Error(
      "AdminTokenStore: refusing to store a blank credential — a stored blank looks configured but " +
        "cannot authenticate anything (fail closed)",
    );
  return token;
}

/** Same fail-closed posture as `requireToken`, for the OPTIONAL `refresh_token` field: `undefined` is a
 *  legitimate "no refresh_token supplied" (F-H — a pre-schema/legacy row, or a caller with none yet), but a
 *  present-and-blank value is not, for the identical reason a blank access token is refused. */
function requireOptionalToken(token: string | undefined, label: string): string | undefined {
  if (token === undefined) return undefined;
  if (typeof token !== "string" || !token.trim())
    throw new Error(
      `AdminTokenStore: refusing to store a blank ${label} — a stored blank looks configured but cannot ` +
        "authenticate anything (fail closed)",
    );
  return token;
}

function requireActor(opts: { actor: string } | undefined): string {
  const actor = opts?.actor;
  if (typeof actor !== "string" || !actor.trim())
    throw new Error(
      "AdminTokenStore: a non-blank `actor` is required — it attributes this write in the immutable audit " +
        "log, and an unattributable credential change is not an auditable one (NN#5)",
    );
  return actor;
}

/**
 * GCM associated data: the collection, the tenant and the row key — DISTINCT from `credentialAad` in
 * `merchant-credential-store.ts` because `ADMIN_CRED_COLLECTION`/`ADMIN_CRED_RECORD_KEY` differ (ADR-0022
 * F2). Binds the ciphertext to THIS row of THIS shop's Admin token, so a relocated or cross-purpose
 * envelope fails authentication instead of decrypting.
 */
function adminCredentialAad(tenantId: string): string {
  return `${ADMIN_CRED_COLLECTION}|${tenantId}|${ADMIN_CRED_RECORD_KEY}`;
}

/**
 * Per-shop, encrypted-at-rest custody for the Shopify Admin offline token, over the two existing ports.
 * `crypto` MUST be a `CryptoPort`, never the read-only `SecretsPort` (this task's governing constraint).
 */
export function createAdminTokenStore(
  state: RuntimeStatePort,
  crypto: CryptoPort,
  opts: AdminTokenStoreOpts = {},
): AdminTokenStore {
  const now = opts.now ?? (() => new Date().toISOString());

  async function writeAndAudit(
    tenantId: string,
    next: AdminTokenWrite,
    actorOpts: { actor: string } | undefined,
    action: "admin_token.store" | "admin_token.refresh",
    decision: string,
  ): Promise<void> {
    const tenant = requireTenantId(tenantId);
    requireToken(next.token);
    const refreshToken = requireOptionalToken(next.refreshToken, "refresh_token");
    const actor = requireActor(actorOpts);
    // Encrypt BEFORE opening the transaction: an unconfigured key must refuse the whole operation with
    // nothing written, and the throw comes from the port with only the tenant, the secret name and the
    // scope in its message — never the token or the key material (crypto-port.ts). This function adds no
    // context of its own to that error for exactly that reason. Both ciphertexts are produced here, before
    // ANY write, so a key failure on EITHER value leaves nothing written or audited (F-B: no partial state).
    const c = await crypto.encrypt(tenant, next.token, adminCredentialAad(tenant), ADMIN_CRED_KEY_SCOPE);
    const rc =
      refreshToken !== undefined
        ? await crypto.encrypt(tenant, refreshToken, adminCredentialAad(tenant), ADMIN_CRED_KEY_SCOPE)
        : undefined;
    // A FRESH object every write, not a merge of the prior row — F-B's "retain neither prior value": a
    // `refresh` that supplies no `refreshToken` (or no `expiresAt`) does not inherit the PREVIOUS row's,
    // it simply has none, because `state.tx`'s `t.put` below replaces the whole row.
    const record: StoredAdminToken = { c, updatedAt: now() };
    if (next.expiresAt !== undefined) record.expiresAt = next.expiresAt;
    if (rc !== undefined) record.rc = rc;
    if (next.refreshTokenExpiresAt !== undefined) record.refreshTokenExpiresAt = next.refreshTokenExpiresAt;

    await state.tx({ tenantId: tenant }, async (t) => {
      const prior = await t.get<StoredAdminToken>(ADMIN_CRED_COLLECTION, ADMIN_CRED_RECORD_KEY);
      // NO ttlSeconds, mirroring merchant-credential-store.ts: an Admin token that quietly expired would
      // send catalog/order sync back to a silent-absence failure with nothing to point at as the cause.
      await t.put(ADMIN_CRED_COLLECTION, ADMIN_CRED_RECORD_KEY, record);
      await t.audit({
        actor,
        action,
        // PII/secret-free by construction: which credential, and whether this overwrote one. Nothing
        // derived from the token, and not the ciphertext either.
        input: { credential: ADMIN_CRED_RECORD_KEY, replaced: prior !== null },
        decision,
        reversalPath:
          "NOT reversible in place — the previous Admin token is overwritten and is not retained anywhere. " +
          "To recover: re-run the shop's app install/authorise flow (or its token-rotation flow) to obtain " +
          "and store a fresh Admin token, and revoke the outgoing token at Shopify.",
      });
    });
  }

  return {
    async put(tenantId, token, writeOpts) {
      await writeAndAudit(
        tenantId,
        {
          token,
          expiresAt: writeOpts?.expiresAt,
          refreshToken: writeOpts?.refreshToken,
          refreshTokenExpiresAt: writeOpts?.refreshTokenExpiresAt,
        },
        writeOpts,
        "admin_token.store",
        "stored",
      );
    },

    async refresh(tenantId, next, writeOpts) {
      await writeAndAudit(tenantId, next, writeOpts, "admin_token.refresh", "refreshed");
    },

    async read(tenantId) {
      const tenant = requireTenantId(tenantId);
      const row = await state.get<StoredAdminToken>({ tenantId: tenant }, ADMIN_CRED_COLLECTION, ADMIN_CRED_RECORD_KEY);
      if (row === null) return { status: "missing" };
      if (typeof row !== "object" || typeof row.c !== "string" || !row.c)
        return { status: "unreadable", reason: "malformed-record" };
      const token = await crypto.decrypt(tenant, row.c, adminCredentialAad(tenant), ADMIN_CRED_KEY_SCOPE);
      // `undefined` here is "a row exists and I cannot read it" — reported AS THAT, never as `missing`.
      if (token === undefined) return { status: "unreadable", reason: "undecryptable" };
      let refreshToken: string | undefined;
      if (row.rc !== undefined) {
        refreshToken = await crypto.decrypt(tenant, row.rc, adminCredentialAad(tenant), ADMIN_CRED_KEY_SCOPE);
        // A row with an undecryptable refresh_token but a readable access token is still corrupt — fail
        // closed the same way an undecryptable access token does, rather than silently dropping the
        // refresh_token and letting the caller treat this as F-H's ordinary "no refresh_token" case.
        if (refreshToken === undefined) return { status: "unreadable", reason: "undecryptable" };
      }
      const found: { status: "found"; token: string; expiresAt?: string; refreshToken?: string; refreshTokenExpiresAt?: string } = {
        status: "found",
        token,
      };
      if (row.expiresAt !== undefined) found.expiresAt = row.expiresAt;
      if (refreshToken !== undefined) found.refreshToken = refreshToken;
      if (row.refreshTokenExpiresAt !== undefined) found.refreshTokenExpiresAt = row.refreshTokenExpiresAt;
      return found;
    },

    async delete(tenantId, writeOpts) {
      const tenant = requireTenantId(tenantId);
      const actor = requireActor(writeOpts);
      await state.tx({ tenantId: tenant }, async (t) => {
        const prior = await t.get<StoredAdminToken>(ADMIN_CRED_COLLECTION, ADMIN_CRED_RECORD_KEY);
        await t.delete(ADMIN_CRED_COLLECTION, ADMIN_CRED_RECORD_KEY);
        await t.audit({
          actor,
          action: "admin_token.delete",
          input: { credential: ADMIN_CRED_RECORD_KEY, existed: prior !== null },
          decision: "deleted",
          reversalPath:
            "NOT reversible — the Admin token existed only as ciphertext in this row and the row is gone. " +
            "To restore access: re-run the shop's app install/authorise flow to obtain and store a new " +
            "Admin token.",
        });
      });
    },
  };
}
