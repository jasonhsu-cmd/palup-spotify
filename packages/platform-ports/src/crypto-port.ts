import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { SecretsPort } from "./secrets-port.js";

// Crypto port (ADR-0001; go-live blocker #2 — ADR-0015 Invariant 9's "encrypted at rest" element for
// special-category facts). The ONLY way feature code encrypts/decrypts data at rest; adapters (this
// local AES-256-GCM one now, a cloud-KMS envelope adapter later) implement it and swap behind it, so no
// vendor crypto/KMS SDK ever leaks into feature code (portability-guard, ADR-0001) — mirrors how
// VectorPort/SecretsPort are shaped.
//
// Tenant-scoped by construction (mirrors SecretsPort.get(tenantId, name)): every op takes a `tenantId`
// and the key material is looked up per-tenant, so one tenant's key compromise/rotation never touches
// another's data — least privilege (CLAUDE.md §3.6).

export interface CryptoPort {
  /**
   * Encrypts `plaintext` for `tenantId`. MUST throw (never silently return plaintext or a fixed
   * placeholder) when no key is configured for this tenant — callers that need fail-closed semantics
   * (ADR-0015 Inv 9: a special-category write is REFUSED, never persisted in the clear) rely on this
   * throwing, not on inspecting the result.
   */
  encrypt(tenantId: string, plaintext: string): Promise<string>;
  /**
   * Decrypts an envelope previously returned by `encrypt` for the SAME `tenantId`. NEVER throws: an
   * unknown envelope shape, a wrong/rotated/missing key, or genuine corruption all resolve to
   * `undefined` so a caller can drop the record rather than crash the turn or surface ciphertext as
   * "garbage" plaintext.
   */
  decrypt(tenantId: string, ciphertext: string): Promise<string | undefined>;
}

export interface AesGcmCryptoOpts {
  /** SecretsPort name this adapter reads the tenant's key material from. Defaults to
   * `"MEMORY_ENCRYPTION_KEY"` so a tenant's encryption key is provisioned exactly like any other
   * tenant secret — never hardcoded, never in env/code directly (SecretsPort is the only path,
   * ADR-0001 / CLAUDE.md §5). */
  secretName?: string;
}

const ENVELOPE_VERSION = "v1"; // envelope format tag — lets a future v2 (e.g. cloud-KMS-wrapped) adapter
// recognize/reject a shape it doesn't understand rather than mis-decrypting it.
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // NIST-recommended GCM nonce size

/**
 * Local, dependency-free AES-256-GCM envelope-encryption adapter for `CryptoPort` — the default
 * implementation until a cloud-KMS adapter (envelope-wrapping a data key via a managed KMS) is built
 * behind this SAME port (ADR-0001: swap the adapter, never the feature code that calls it).
 *
 * KEY DERIVATION — documented, not hidden: the string `SecretsPort.get(tenantId, secretName)` returns
 * is not assumed to already be exactly 32 raw key bytes (an operator may provision a passphrase, a
 * base64 string, a hex string, anything) — SHA-256 of the UTF-8 secret deterministically derives a
 * 256-bit AES key from whatever value is configured. This is a convenience KDF, not a substitute for
 * provisioning a high-entropy secret in production; a cloud-KMS adapter replacing this later need not
 * keep this derivation, it only has to satisfy the same `CryptoPort` contract.
 *
 * ENVELOPE SHAPE: `v1:<base64 iv>:<base64 authTag>:<base64 ciphertext>` — versioned + self-describing so
 * `decrypt` can recognize a corrupt/foreign-shaped string and return `undefined` rather than guess.
 *
 * FAIL CLOSED: `encrypt` throws (never returns a plaintext fallback) when `secrets.get` resolves to
 * undefined/empty for `tenantId` — the caller (widget-memory's service.ts) is the one that decides what
 * "no key" means for a given write (refuse for special-category, best-effort-plaintext for ordinary);
 * this adapter never makes that policy call itself, it only ever refuses to fake-encrypt.
 */
export function createAesGcmCrypto(secrets: SecretsPort, opts: AesGcmCryptoOpts = {}): CryptoPort {
  const secretName = opts.secretName ?? "MEMORY_ENCRYPTION_KEY";

  async function keyFor(tenantId: string): Promise<Buffer> {
    const raw = await secrets.get(tenantId, secretName);
    if (!raw) {
      throw new Error(
        `CryptoPort: no "${secretName}" key configured for tenant "${tenantId}" — refusing to encrypt/decrypt (fail closed)`,
      );
    }
    return createHash("sha256").update(raw, "utf8").digest();
  }

  return {
    async encrypt(tenantId, plaintext) {
      const key = await keyFor(tenantId); // throws when unconfigured — see the file-header fail-closed note
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const authTag = cipher.getAuthTag();
      return [ENVELOPE_VERSION, iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
    },

    async decrypt(tenantId, envelope) {
      try {
        const parts = envelope.split(":");
        if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) return undefined; // unknown/foreign shape
        const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
        const key = await keyFor(tenantId); // no key configured -> caught below -> undefined, never throws
        const iv = Buffer.from(ivB64, "base64");
        const authTag = Buffer.from(tagB64, "base64");
        const data = Buffer.from(dataB64, "base64");
        const decipher = createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);
        const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
        return plaintext.toString("utf8");
      } catch {
        // Wrong/rotated/missing key, tampered ciphertext/auth tag, malformed base64, … — ALL of these
        // collapse to "can't read this record", never a thrown error (fail closed on read: the caller
        // drops the record rather than crashing the turn or surfacing ciphertext as plaintext "garbage").
        return undefined;
      }
    },
  };
}
