import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import type { SecretsPort } from "./secrets-port.js";

// Crypto port (ADR-0001; go-live blocker #2 — ADR-0015 Invariant 9's "encrypted at rest" element for
// special-category facts). The ONLY way widget-memory encrypts/decrypts data at rest; adapters (this
// local AES-256-GCM one now, a cloud-KMS envelope adapter later) implement it and swap behind it, so no
// vendor crypto/KMS SDK ever leaks into feature code (portability-guard, ADR-0001) — mirrors how
// VectorPort/SecretsPort are shaped. NOTE (security review, feat/memory-encryption-at-rest, finding 8):
// widget-backend's customer-grant-store.ts (ADR-0018, OAuth-grant custody) still hand-rolls its own
// inline AES-256-GCM rather than depending on this port — see that file's own header note. This port is
// the ONLY path for widget-memory's at-rest encryption; it is not (yet) the only encryption code in the
// repo, and this file no longer claims otherwise.
//
// Tenant-scoped by construction (mirrors SecretsPort.get(tenantId, name)): every op takes a `tenantId`
// and the key material is looked up per-tenant AND mixed into the derived key itself (HKDF `info` — see
// `deriveKey` below) so two tenants provisioned with the IDENTICAL raw secret still get DIFFERENT AES
// keys — one tenant's key compromise/rotation never touches another's data (least privilege, CLAUDE.md
// §3.6; security review finding 3).
//
// KEY SCOPE (A3). A tenant may need MORE THAN ONE key: a per-purpose key so a compromise of the
// memory-encryption key does not also expose stored merchant credentials, and independent rotation
// schedules for each. Before this, the port had no way to say WHICH key produced a ciphertext, so
// neither could be expressed. `keyScope` is that name: an optional, non-secret, lowercase label that
// (a) selects the key material, (b) is recorded in the envelope so a decrypt knows which key to ask
// for, and (c) is bound into the GCM aad so a ciphertext from one scope can never be read under
// another — even if an operator provisioned both scopes with identical raw material.
//
// The two fail-closed rules, because the brief for this port pulls in two directions (back-compat vs.
// "a missing scope must be an error") and the resolution has to be explicit rather than implied:
//   1. OMITTING `keyScope` entirely is the DEFAULT SCOPE, which is byte-for-byte today's behavior
//      (`v1:` envelopes, the same secret name, the same HKDF info). That is what keeps every existing
//      caller and every already-stored row working, and it is a documented contract, not a fallback.
//   2. A scope that is PRESENT BUT BLANK OR MALFORMED is an ERROR, never coerced into the default; and
//      a scope MISMATCH between the envelope and the request never falls back to another key. An
//      unconfigured scope refuses (encrypt throws / decrypt yields undefined) even when the default
//      scope's key IS configured.

/**
 * The scope used when a caller passes no `keyScope`. Envelope version `v1` IS this scope by definition —
 * a v1 envelope predates scopes and can only ever have come from the default key.
 */
export const DEFAULT_KEY_SCOPE = "default";

export interface CryptoPort {
  /**
   * Encrypts `plaintext` for `tenantId`, binding the resulting ciphertext to `aad` (additional
   * authenticated data — the caller's own record-identity string, e.g. `${recordId}|${field}`) via
   * AES-GCM so the envelope can never be decrypted successfully after being copied/relocated onto a
   * different record or field (security review finding 4 — "ciphertext can be relocated between
   * records"). MUST throw (never silently return plaintext or a fixed placeholder) when no key is
   * configured for this tenant AND scope — callers that need fail-closed semantics (ADR-0015 Inv 9: a
   * special-category write is REFUSED, never persisted in the clear) rely on this throwing, not on
   * inspecting the result.
   *
   * `keyScope` selects WHICH of the tenant's keys to use (see the module header). Omit it for the
   * default scope — today's behavior. A blank/malformed scope throws; an unconfigured scope throws
   * rather than falling back to the default key.
   */
  encrypt(tenantId: string, plaintext: string, aad: string, keyScope?: string): Promise<string>;
  /**
   * Decrypts an envelope previously returned by `encrypt` for the SAME `tenantId`, the SAME `aad` AND
   * the SAME `keyScope`. Resolves to `undefined` — never throws — for an unknown envelope shape, a
   * wrong/rotated/missing/other-scope key, a mismatched `aad` (the ciphertext was moved to a different
   * record/field), or genuine corruption, so a caller can drop the record rather than crash the turn or
   * surface ciphertext as "garbage" plaintext.
   *
   * THE ONE EXCEPTION, and it is deliberate: a `keyScope` argument that is blank or malformed THROWS.
   * That is a caller bug, not unreadable data — resolving it to `undefined` would tell a caller with a
   * typo'd scope that its records are undecryptable, which is exactly the "an absent read looks like a
   * valid answer" defect this repo keeps getting bitten by. Argument validation happens before any key
   * lookup or crypto, so nothing is attempted with the wrong key first.
   */
  decrypt(tenantId: string, ciphertext: string, aad: string, keyScope?: string): Promise<string | undefined>;
}

export interface AesGcmCryptoOpts {
  /** SecretsPort name this adapter reads the tenant's DEFAULT-scope key material from. Defaults to
   * `"MEMORY_ENCRYPTION_KEY"` so a tenant's encryption key is provisioned exactly like any other
   * tenant secret — never hardcoded, never in env/code directly (SecretsPort is the only path,
   * ADR-0001 / CLAUDE.md §5). A rotation keeps the OUTGOING value available for one cycle at
   * `"<secretName>_previous"` (see the module header's key-rotation note) so already-encrypted records
   * stay decryptable across the rotation instead of silently failing en masse. A non-default key scope
   * reads its own name, `keyScopeSecretName(secretName, scope)`, and rotates the same way. */
  secretName?: string;
  /**
   * OPT-IN shared base key. When set, it is a reserved, NON-real-tenant SecretsPort id (e.g. "__shared__")
   * under which a single shared base key is provisioned. If a tenant has NO per-tenant key for the requested
   * scope, the adapter derives that tenant's key from the shared base (via deriveKey, which mixes tenantId
   * into HKDF — so each tenant STILL gets a distinct AES key) instead of throwing. The shared base is read
   * under the SAME per-scope secret name as the per-tenant key (keyScopeSecretName(secretName, keyScope)), so
   * each key scope has its own independent shared base — a merchant-cred shared base can never serve the
   * default/memory scope. When UNDEFINED (the default), behavior is byte-for-byte today's: per-tenant key
   * required, encrypt throws if absent. Per-tenant keys always take precedence over the shared base.
   */
  sharedKeyTenantId?: string;
}

const ENVELOPE_V1 = "v1"; // pre-scope envelope. By definition the DEFAULT key scope: it could not have
// been produced by any other, so a v1 row needs no migration and stays readable forever.
const ENVELOPE_V2 = "v2"; // scoped envelope: `v2:<scope>:<keyId>:<iv>:<authTag>:<ciphertext>`.
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // NIST-recommended GCM nonce size
const HKDF_KEY_BYTES = 32; // AES-256 key size
const KEY_ID_HEX_CHARS = 8; // short, non-secret fingerprint of the DERIVED key — identifies a key
// GENERATION for a tenant, not a security boundary (see `deriveKey` below).
// Entropy floor on the RAW secret material before HKDF derives a key from it (security review, finding
// 3): the prior single-round unsalted SHA-256 KDF happily "derived" a key from a one-character
// passphrase, and GCM gives an offline verification oracle for brute-forcing a weak one from a single
// stolen row. This is a floor, not a substitute for provisioning a genuinely high-entropy secret in
// production.
const MIN_KEY_MATERIAL_BYTES = 16;
const PREVIOUS_KEY_SUFFIX = "_previous";
const ENVELOPE_V1_PARTS = 5; // v1:keyId:iv:authTag:ciphertext
const ENVELOPE_V2_PARTS = 6; // v2:scope:keyId:iv:authTag:ciphertext
/** Separator between the base secret name and a key scope. Doubled so it cannot be produced by a scope
 *  name (which may not contain `_` — see `KEY_SCOPE_RE`) nor collide with the base name itself. */
const KEY_SCOPE_SEPARATOR = "__";
/**
 * A key scope is a lowercase label, not key material and not free text: `[a-z0-9]` then `[a-z0-9-]`, at
 * most 64 chars. Why each restriction is load-bearing rather than tidiness:
 *   - no `:`      — the envelope is colon-delimited; a scope with a colon would forge extra fields.
 *   - no `_`      — a per-scope secret name gets the `_previous` rotation suffix appended, so a scope
 *                   named `x_previous` would otherwise alias scope `x`'s OUTGOING key.
 *   - lowercase   — case-variant scopes would silently split a tenant's keys in two.
 *   - length cap  — bounds what a scope can put into a secret name and into an error string.
 */
const KEY_SCOPE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

interface DerivedKey {
  key: Buffer;
  keyId: string;
}

/**
 * Validates a `keyScope` argument, resolving an omitted one to `DEFAULT_KEY_SCOPE`. THROWS for a blank
 * or malformed scope — never coerces it into the default (module header, rule 2). The rejection message
 * states the rule and does NOT echo the offending value: a scope is caller-supplied and lands in logs
 * (same reasoning as `resolveEmbedKeys` in widget-backend, which names the variable and the rule but
 * never the value).
 */
export function requireKeyScope(keyScope: string | undefined): string {
  if (keyScope === undefined) return DEFAULT_KEY_SCOPE;
  if (typeof keyScope !== "string" || !KEY_SCOPE_RE.test(keyScope))
    throw new Error(
      "CryptoPort: keyScope must match /^[a-z0-9][a-z0-9-]{0,63}$/ (lowercase letters, digits and hyphens; " +
        "no underscore, no colon) — a blank or malformed scope is an error, never the default scope (fail closed)",
    );
  return keyScope;
}

/**
 * SecretsPort name holding the key material for one scope. The DEFAULT scope keeps the bare `secretName`
 * (so nothing already provisioned moves); every other scope gets its own name, which is what lets an
 * operator provision genuinely INDEPENDENT material per scope and rotate each on its own schedule via
 * the same `<name>_previous` convention. An unconfigured scope therefore resolves to "no secret" and
 * fails closed — it can never silently reach the default scope's key.
 */
export function keyScopeSecretName(secretName: string, keyScope: string | undefined): string {
  const scope = requireKeyScope(keyScope);
  return scope === DEFAULT_KEY_SCOPE ? secretName : `${secretName}${KEY_SCOPE_SEPARATOR}${scope}`;
}

/**
 * HKDF-SHA256-derives a 256-bit AES key from arbitrary `raw` secret material, with `tenantId` mixed in
 * as the HKDF `info` parameter (security review finding 3) — so two tenants sharing the identical raw
 * secret still get different keys, unlike the prior plain `sha256(raw)` KDF. Throws when `raw` is
 * shorter than `MIN_KEY_MATERIAL_BYTES` — a low-entropy passphrase is never silently accepted. Returns,
 * alongside the key, a short, NON-SECRET fingerprint of the DERIVED key (`keyId`, stored in the envelope
 * — see the module header's rotation note) so a rotation is detectable/recoverable rather than a silent,
 * untraceable mass decrypt failure (security review finding 5).
 */
function deriveKey(tenantId: string, raw: string): DerivedKey {
  if (Buffer.byteLength(raw, "utf8") < MIN_KEY_MATERIAL_BYTES) {
    throw new Error(
      `CryptoPort: key material for tenant "${tenantId}" is shorter than the ${MIN_KEY_MATERIAL_BYTES}-byte ` +
        `minimum — refusing to derive an AES key from low-entropy material (fail closed)`,
    );
  }
  const key = Buffer.from(
    hkdfSync("sha256", Buffer.from(raw, "utf8"), Buffer.alloc(0), Buffer.from(tenantId, "utf8"), HKDF_KEY_BYTES),
  );
  const keyId = createHash("sha256").update(key).digest("hex").slice(0, KEY_ID_HEX_CHARS);
  return { key, keyId };
}

/**
 * GCM associated data actually bound into the ciphertext: the port's own envelope version, the KEY SCOPE
 * (for v2), and the caller-supplied `aad` (record-identity string) — so a foreign-shaped/wrong-version
 * envelope can never be coerced into matching by accident, and a ciphertext from one scope fails
 * authentication under another EVEN IF both scopes were provisioned with identical raw key material.
 *
 * The default scope's form is exactly the pre-scope one (`v1|<aad>`), which is what keeps every
 * already-stored row decryptable.
 */
function gcmAad(aad: string, keyScope: string): Buffer {
  return keyScope === DEFAULT_KEY_SCOPE
    ? Buffer.from(`${ENVELOPE_V1}|${aad}`, "utf8")
    : Buffer.from(`${ENVELOPE_V2}|${keyScope}|${aad}`, "utf8");
}

/**
 * Local, dependency-free AES-256-GCM envelope-encryption adapter for `CryptoPort` — the default
 * implementation until a cloud-KMS adapter (envelope-wrapping a data key via a managed KMS) is built
 * behind this SAME port (ADR-0001: swap the adapter, never the feature code that calls it).
 *
 * KEY DERIVATION — documented, not hidden: the string `SecretsPort.get(tenantId, secretName)` returns is
 * not assumed to already be exactly 32 raw key bytes (an operator may provision a passphrase, a base64
 * string, a hex string, anything) — HKDF-SHA256 (info = tenantId, security review finding 3)
 * deterministically derives a 256-bit AES key from whatever value is configured, after checking it clears
 * `MIN_KEY_MATERIAL_BYTES`. This is a convenience KDF, not a substitute for provisioning a high-entropy
 * secret in production; a cloud-KMS adapter replacing this later need not keep this derivation, it only
 * has to satisfy the same `CryptoPort` contract.
 *
 * ENVELOPE SHAPE — two versions, and `v1` is not legacy-to-be-migrated, it is the DEFAULT SCOPE:
 *   - default scope (no `keyScope` passed): `v1:<hex keyId>:<base64 iv>:<base64 authTag>:<base64 ct>`
 *     — unchanged, byte for byte, from before key scopes existed. Every row already written stays
 *     readable and every existing caller keeps producing exactly this.
 *   - any other scope: `v2:<scope>:<hex keyId>:<base64 iv>:<base64 authTag>:<base64 ct>` — the scope is
 *     recorded so `decrypt` knows which key to ask for, and a scope MISMATCH is refused before any key
 *     lookup rather than trying another key.
 * Both are versioned + self-describing so `decrypt` can recognize a corrupt/foreign-shaped string and
 * return `undefined` rather than guess. The `keyId` is a hex fingerprint of the DERIVED key (never the
 * raw secret), present so a rotated-out key is DETECTABLE rather than indistinguishable from corruption.
 *
 * KEY ROTATION (security review finding 5): `decrypt` tries the CURRENT key for the requested scope
 * first; if the envelope's `keyId` doesn't match, it falls back to that scope's `"<name>_previous"` (if
 * configured). An operator rotating a key should, for one rotation cycle, move the outgoing value to
 * `"<name>_previous"` and put the new value at `<name>` — existing records then keep decrypting via the
 * fallback while new writes use the new key. `<name>` is `secretName` for the default scope and
 * `keyScopeSecretName(secretName, scope)` otherwise, so EACH SCOPE ROTATES INDEPENDENTLY and rotating
 * one never touches another's records. Without keeping the previous value around, the affected records
 * are genuinely unrecoverable. It is not SILENT — `recall` counts records it had to drop as
 * undecryptable and emits a PII-free `recall.dropped` audit (count only) — but that is detection after
 * the fact, not recovery: once the outgoing key is gone the plaintext is gone. The operator runbook for
 * the two-step rotation lives in `docs/DEPLOY.md`; it currently documents the default scope only,
 * because no caller uses a non-default scope yet — the first one (the merchant credential store) must
 * extend it with its own scope's secret names.
 *
 * FAIL CLOSED: `encrypt` throws (never returns a plaintext fallback) when `secrets.get` resolves to
 * undefined/empty for `tenantId` AND THE REQUESTED SCOPE, or when the configured material is below the
 * entropy floor — the caller (widget-memory's service.ts) is the one that decides what "no key" means
 * for a given write (refuse for special-category, best-effort-plaintext for ordinary); this adapter never
 * makes that policy call itself, it only ever refuses to fake-encrypt. A scope with no key configured is
 * refused even when the DEFAULT scope's key is present — there is no cross-scope fallback.
 */
export function createAesGcmCrypto(secrets: SecretsPort, opts: AesGcmCryptoOpts = {}): CryptoPort {
  const secretName = opts.secretName ?? "MEMORY_ENCRYPTION_KEY";
  const sharedKeyTenantId = opts.sharedKeyTenantId; // opt-in; undefined ⇒ byte-for-byte today's behavior

  /** Per-tenant key MATERIAL for one scope, or undefined — never throws. The default scope reads the bare
   *  `secretName` (exactly as before); other scopes read `keyScopeSecretName(secretName, scope)`. */
  async function perTenantRaw(tenantId: string, keyScope: string): Promise<string | undefined> {
    return secrets.get(tenantId, keyScopeSecretName(secretName, keyScope));
  }

  /** Shared-base key MATERIAL for one scope, or undefined. Opt-in only (returns undefined when the opt is
   *  off, so the opt-OFF path never even queries the shared id). Read under the SAME per-scope secret name
   *  as the per-tenant key, so each scope has its OWN independent shared base — no cross-scope leak. */
  async function sharedRaw(keyScope: string): Promise<string | undefined> {
    if (!sharedKeyTenantId) return undefined;
    return secrets.get(sharedKeyTenantId, keyScopeSecretName(secretName, keyScope));
  }

  /** Key material for one scope: per-tenant FIRST, else the opt-in shared base. Throws the existing
   *  fail-closed error when NEITHER is configured. Both branches go through `deriveKey(tenantId, …)`, so the
   *  entropy floor AND the tenantId-into-HKDF mixing apply to the shared base too — two tenants deriving
   *  from the identical shared base still get DIFFERENT AES keys. */
  async function currentKey(tenantId: string, keyScope: string): Promise<DerivedKey> {
    // Belt-and-suspenders (security review, defense-in-depth): the reserved shared-key id is NOT a real
    // tenant. Only reachable when the opt is on, so opt-OFF behavior is byte-for-byte unchanged. If a
    // future call site ever routed the reserved id AS a tenantId, refuse rather than let that "tenant"
    // read the shared base as its own per-tenant key — the reserved-id safety is now enforced in code,
    // not only in a comment. Real tenants (lowercased shop subdomains) can never equal it, so this is
    // unreachable today. Encrypt propagates the throw (fail closed); decrypt catches it → undefined.
    if (sharedKeyTenantId && tenantId === sharedKeyTenantId)
      throw new Error(
        `CryptoPort: tenantId must not equal the reserved shared-key id (key scope "${keyScope}") — ` +
          `refusing to encrypt/decrypt (fail closed)`,
      );
    const name = keyScopeSecretName(secretName, keyScope);
    const raw = (await perTenantRaw(tenantId, keyScope)) ?? (await sharedRaw(keyScope));
    if (!raw) {
      // Names the tenant, the secret it looked for, and the scope — all non-secret — and never the
      // material (there is none configured to leak). NO fallback to another scope's key, and — when the
      // opt is off — no shared base either (sharedRaw returned undefined).
      throw new Error(
        `CryptoPort: no "${name}" key configured for tenant "${tenantId}" (key scope "${keyScope}") — ` +
          `refusing to encrypt/decrypt (fail closed)`,
      );
    }
    return deriveKey(tenantId, raw);
  }

  async function previousKey(tenantId: string, keyScope: string): Promise<DerivedKey | undefined> {
    const raw = await secrets.get(tenantId, `${keyScopeSecretName(secretName, keyScope)}${PREVIOUS_KEY_SUFFIX}`);
    if (!raw) return undefined;
    try {
      return deriveKey(tenantId, raw);
    } catch {
      return undefined; // a too-short/garbage previous-key value is just treated as "no previous key"
    }
  }

  /** The tenant's key DERIVED FROM THE SHARED BASE for one scope, or undefined (opt-off ⇒ undefined). A
   *  decrypt-only fallback candidate: it keeps an envelope written under the shared base readable even
   *  after an operator later provisions a per-tenant key (which then WINS in `currentKey`). Gated on the
   *  opt so opt-OFF decrypt is byte-identical to today. */
  async function sharedKey(tenantId: string, keyScope: string): Promise<DerivedKey | undefined> {
    if (sharedKeyTenantId && tenantId === sharedKeyTenantId) return undefined; // reserved id is not a tenant
    const raw = await sharedRaw(keyScope);
    if (!raw) return undefined;
    try {
      return deriveKey(tenantId, raw);
    } catch {
      return undefined; // a too-short/garbage shared base is treated as "no shared candidate" on read
    }
  }

  return {
    async encrypt(tenantId, plaintext, aad, keyScope) {
      const scope = requireKeyScope(keyScope); // throws on a blank/malformed scope, before any key lookup
      const { key, keyId } = await currentKey(tenantId, scope); // throws when unconfigured — see file header
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      cipher.setAAD(gcmAad(aad, scope));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const authTag = cipher.getAuthTag();
      const body = [keyId, iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")];
      // The default scope keeps emitting the pre-scope v1 shape (v1 IS the default scope), so no stored
      // row and no existing reader changes; a scoped write records its scope in a v2 envelope.
      return scope === DEFAULT_KEY_SCOPE
        ? [ENVELOPE_V1, ...body].join(":")
        : [ENVELOPE_V2, scope, ...body].join(":");
    },

    async decrypt(tenantId, envelope, aad, keyScope) {
      // Outside the try/catch on purpose: a malformed scope ARGUMENT is a caller bug and must surface as
      // a throw, not as "this record is undecryptable" (see the port's `decrypt` doc comment).
      const scope = requireKeyScope(keyScope);
      try {
        const parts = envelope.split(":");
        let keyId: string, ivB64: string, tagB64: string, dataB64: string;
        if (parts[0] === ENVELOPE_V1) {
          // A v1 envelope can only have come from the default key, so it is readable under the default
          // scope and NOTHING else — asking for it under another scope is a mismatch, not a fallback.
          if (parts.length !== ENVELOPE_V1_PARTS || scope !== DEFAULT_KEY_SCOPE) return undefined;
          [, keyId, ivB64, tagB64, dataB64] = parts as [string, string, string, string, string];
        } else if (parts[0] === ENVELOPE_V2) {
          if (parts.length !== ENVELOPE_V2_PARTS) return undefined;
          const [, envScope, ...rest] = parts as [string, string, string, string, string, string];
          // Scope mismatch is refused HERE, before any key lookup: no other scope's key is ever tried.
          if (envScope !== scope) return undefined;
          [keyId, ivB64, tagB64, dataB64] = rest;
        } else {
          return undefined; // unknown/foreign shape
        }

        // Try the CURRENT key first (the common case); fall back to the PREVIOUS key only when the
        // envelope's keyId doesn't match it — this is what makes a rotation recoverable rather than a
        // silent, untraceable mass decrypt failure (finding 5). Both are scoped to `scope`, so a
        // rotation in one scope never affects another. Neither lookup throws past this point.
        const current = await currentKey(tenantId, scope).catch(() => undefined);
        let key = current?.keyId === keyId ? current.key : undefined;
        if (!key) {
          const previous = await previousKey(tenantId, scope);
          if (previous?.keyId === keyId) key = previous.key;
        }
        // Shared-base fallback (opt-in only): a token written under the shared base must stay readable even
        // after an operator provisions a per-tenant key for this tenant — which now WINS in `currentKey`,
        // so neither `current` (per-tenant) nor `previous` matches the shared-derived keyId. `sharedKey`
        // returns undefined when the opt is off, so the opt-OFF read path is byte-identical to before; and
        // when the shared base already WAS `current`, `key` is set so this block is skipped (no-op).
        if (!key && sharedKeyTenantId) {
          const shared = await sharedKey(tenantId, scope);
          if (shared?.keyId === keyId) key = shared.key;
        }
        if (!key) return undefined; // no configured key (current, previous, or shared base) matches this envelope

        const iv = Buffer.from(ivB64, "base64");
        const authTag = Buffer.from(tagB64, "base64");
        const data = Buffer.from(dataB64, "base64");
        const decipher = createDecipheriv(ALGORITHM, key, iv);
        decipher.setAAD(gcmAad(aad, scope));
        decipher.setAuthTag(authTag);
        const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
        return plaintext.toString("utf8");
      } catch {
        // Wrong/rotated/missing key, a mismatched aad (relocated ciphertext), tampered ciphertext/auth
        // tag, malformed base64, … — ALL of these collapse to "can't read this record", never a thrown
        // error (fail closed on read: the caller drops the record rather than crashing the turn or
        // surfacing ciphertext as plaintext "garbage").
        return undefined;
      }
    },
  };
}
