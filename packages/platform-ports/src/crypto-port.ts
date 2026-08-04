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

export interface CryptoPort {
  /**
   * Encrypts `plaintext` for `tenantId`, binding the resulting ciphertext to `aad` (additional
   * authenticated data — the caller's own record-identity string, e.g. `${recordId}|${field}`) via
   * AES-GCM so the envelope can never be decrypted successfully after being copied/relocated onto a
   * different record or field (security review finding 4 — "ciphertext can be relocated between
   * records"). MUST throw (never silently return plaintext or a fixed placeholder) when no key is
   * configured for this tenant — callers that need fail-closed semantics (ADR-0015 Inv 9: a
   * special-category write is REFUSED, never persisted in the clear) rely on this throwing, not on
   * inspecting the result.
   */
  encrypt(tenantId: string, plaintext: string, aad: string): Promise<string>;
  /**
   * Decrypts an envelope previously returned by `encrypt` for the SAME `tenantId` AND the SAME `aad`.
   * NEVER throws: an unknown envelope shape, a wrong/rotated/missing key, a mismatched `aad` (the
   * ciphertext was moved to a different record/field), or genuine corruption all resolve to `undefined`
   * so a caller can drop the record rather than crash the turn or surface ciphertext as "garbage"
   * plaintext.
   */
  decrypt(tenantId: string, ciphertext: string, aad: string): Promise<string | undefined>;
}

export interface AesGcmCryptoOpts {
  /** SecretsPort name this adapter reads the tenant's key material from. Defaults to
   * `"MEMORY_ENCRYPTION_KEY"` so a tenant's encryption key is provisioned exactly like any other
   * tenant secret — never hardcoded, never in env/code directly (SecretsPort is the only path,
   * ADR-0001 / CLAUDE.md §5). A rotation keeps the OUTGOING value available for one cycle at
   * `"<secretName>_previous"` (see the module header's key-rotation note) so already-encrypted records
   * stay decryptable across the rotation instead of silently failing en masse. */
  secretName?: string;
}

const ENVELOPE_VERSION = "v1"; // envelope format tag — lets a future v2 (e.g. cloud-KMS-wrapped) adapter
// recognize/reject a shape it doesn't understand rather than mis-decrypting it.
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
const ENVELOPE_PARTS = 5; // v1:keyId:iv:authTag:ciphertext

interface DerivedKey {
  key: Buffer;
  keyId: string;
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

/** GCM associated data actually bound into the ciphertext: the port's own envelope version PLUS the
 * caller-supplied `aad` (record-identity string) — so a foreign-shaped/wrong-version envelope can never
 * be coerced into matching by accident. */
function gcmAad(aad: string): Buffer {
  return Buffer.from(`${ENVELOPE_VERSION}|${aad}`, "utf8");
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
 * ENVELOPE SHAPE: `v1:<hex keyId>:<base64 iv>:<base64 authTag>:<base64 ciphertext>` — versioned +
 * self-describing so `decrypt` can recognize a corrupt/foreign-shaped string and return `undefined`
 * rather than guess. The `keyId` is a hex fingerprint of the DERIVED key (never the raw secret), present
 * so a rotated-out key is DETECTABLE rather than indistinguishable from corruption.
 *
 * KEY ROTATION (security review finding 5): `decrypt` tries the CURRENT `secretName` key first; if the
 * envelope's `keyId` doesn't match, it falls back to `"<secretName>_previous"` (if configured). An
 * operator rotating the key should, for one rotation cycle, move the outgoing value to
 * `"<secretName>_previous"` and put the new value at `secretName` — existing records then keep
 * decrypting via the fallback while new writes use the new key. Without keeping the previous value
 * around, the affected records are genuinely unrecoverable. It is not SILENT — `recall` counts records
 * it had to drop as undecryptable and emits a PII-free `recall.dropped` audit (count only) — but that is
 * detection after the fact, not recovery: once the outgoing key is gone the plaintext is gone. The
 * operator runbook for the two-step rotation lives in `docs/DEPLOY.md`.
 *
 * FAIL CLOSED: `encrypt` throws (never returns a plaintext fallback) when `secrets.get` resolves to
 * undefined/empty for `tenantId`, or when the configured material is below the entropy floor — the
 * caller (widget-memory's service.ts) is the one that decides what "no key" means for a given write
 * (refuse for special-category, best-effort-plaintext for ordinary); this adapter never makes that
 * policy call itself, it only ever refuses to fake-encrypt.
 */
export function createAesGcmCrypto(secrets: SecretsPort, opts: AesGcmCryptoOpts = {}): CryptoPort {
  const secretName = opts.secretName ?? "MEMORY_ENCRYPTION_KEY";

  async function currentKey(tenantId: string): Promise<DerivedKey> {
    const raw = await secrets.get(tenantId, secretName);
    if (!raw) {
      throw new Error(
        `CryptoPort: no "${secretName}" key configured for tenant "${tenantId}" — refusing to encrypt/decrypt (fail closed)`,
      );
    }
    return deriveKey(tenantId, raw);
  }

  async function previousKey(tenantId: string): Promise<DerivedKey | undefined> {
    const raw = await secrets.get(tenantId, `${secretName}${PREVIOUS_KEY_SUFFIX}`);
    if (!raw) return undefined;
    try {
      return deriveKey(tenantId, raw);
    } catch {
      return undefined; // a too-short/garbage previous-key value is just treated as "no previous key"
    }
  }

  return {
    async encrypt(tenantId, plaintext, aad) {
      const { key, keyId } = await currentKey(tenantId); // throws when unconfigured — see file header
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      cipher.setAAD(gcmAad(aad));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const authTag = cipher.getAuthTag();
      return [
        ENVELOPE_VERSION,
        keyId,
        iv.toString("base64"),
        authTag.toString("base64"),
        ciphertext.toString("base64"),
      ].join(":");
    },

    async decrypt(tenantId, envelope, aad) {
      try {
        const parts = envelope.split(":");
        if (parts.length !== ENVELOPE_PARTS || parts[0] !== ENVELOPE_VERSION) return undefined; // unknown/foreign shape
        const [, keyId, ivB64, tagB64, dataB64] = parts as [string, string, string, string, string];

        // Try the CURRENT key first (the common case); fall back to the PREVIOUS key only when the
        // envelope's keyId doesn't match it — this is what makes a rotation recoverable rather than a
        // silent, untraceable mass decrypt failure (finding 5). Neither lookup throws past this point.
        const current = await currentKey(tenantId).catch(() => undefined);
        let key = current?.keyId === keyId ? current.key : undefined;
        if (!key) {
          const previous = await previousKey(tenantId);
          if (previous?.keyId === keyId) key = previous.key;
        }
        if (!key) return undefined; // no configured key (current or previous) matches this envelope

        const iv = Buffer.from(ivB64, "base64");
        const authTag = Buffer.from(tagB64, "base64");
        const data = Buffer.from(dataB64, "base64");
        const decipher = createDecipheriv(ALGORITHM, key, iv);
        decipher.setAAD(gcmAad(aad));
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
