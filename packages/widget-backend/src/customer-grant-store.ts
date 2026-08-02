import { createHash, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import type { RuntimeStatePort, SecretsPort } from "@palup/platform-ports";

// Encrypted per-shopper OAuth grant custody (ADR-0018 tasks 1 + 6). Task-1 decision (owner-confirmed):
// app-layer AES-256-GCM envelope encryption over the UNCHANGED RuntimeStatePort — the port stays a plain
// KV (zero ADR-0001 port-contract change), the widget-backend encrypts the grant value before put and
// decrypts after get. The grant (a renewable, high-blast-radius customer credential) is NEVER stored in
// plaintext, never leaves the server, never logged. Tenant-scoped by RuntimeStateCtx.tenantId, keyed by
// the namespaced shopperId. Decision-A (owner, this session): the grant is CREDENTIAL CUSTODY, not
// ADR-0015 durable memory — so it is NOT consent-gated as memory, but it MUST honor data-subject erasure
// (deleteGrant) and EU data-residency for where it is stored.

const GRANTS = "caa_grants";
/** App-scoped SecretsPort location of the 32-byte data-encryption key (base material, hashed to 32 bytes). */
export const CAA_GRANT_KEY_SCOPE = "__shopify_app__";
export const CAA_GRANT_KEY_NAME = "caa_grant_encryption_key";

/** What we custody per shopper. Short access-token TTL; refresh token renews it server-side. */
export interface StoredGrant {
  accessToken: string;
  refreshToken?: string;
  /** Unix seconds when the access token expires (from `expires_in`), if known. */
  expiresAt?: number;
  scope?: string;
  grantedAt: number;
}

// --- AES-256-GCM envelope (iv | authTag | ciphertext, all base64) -----------------------------------
function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}
function decrypt(key: Buffer, blob: string): string | null {
  try {
    const buf = Buffer.from(blob, "base64");
    if (buf.length < 12 + 16 + 1) return null;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const d = createDecipheriv("aes-256-gcm", key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8"); // throws on a bad tag → caught
  } catch {
    return null; // tampered / wrong key ⇒ fail closed
  }
}

export interface CustomerGrantStore {
  put(tenant: string, shopperId: string, grant: StoredGrant): Promise<void>;
  get(tenant: string, shopperId: string): Promise<StoredGrant | null>;
  delete(tenant: string, shopperId: string): Promise<void>;
  /** True only when the encryption key is provisioned — the callback must refuse to store a grant otherwise. */
  ready(): Promise<boolean>;
}

/**
 * Build the grant store. The data key is derived (SHA-256) from an app-scoped SecretsPort secret, so the
 * stored secret can be any high-entropy string. If the key is absent, put()/get() fail closed (no
 * plaintext fallback). The stored value is `{ c: <base64 envelope> }` — a plain KV doc to RuntimeState.
 */
export function createCustomerGrantStore(store: RuntimeStatePort, secrets: SecretsPort): CustomerGrantStore {
  let keyCache: Buffer | null | undefined;
  const getKey = async (): Promise<Buffer | null> => {
    if (keyCache !== undefined) return keyCache;
    const material = await secrets.get(CAA_GRANT_KEY_SCOPE, CAA_GRANT_KEY_NAME);
    keyCache = material ? createHash("sha256").update(material).digest() : null;
    return keyCache;
  };
  return {
    async ready() {
      return (await getKey()) !== null;
    },
    async put(tenant, shopperId, grant) {
      const key = await getKey();
      if (!key) throw new Error("caa grant encryption key not configured"); // never store plaintext
      await store.put(
        { tenantId: tenant },
        GRANTS,
        shopperId,
        { c: encrypt(key, JSON.stringify(grant)) },
        { ttlSeconds: 60 * 60 * 24 * 30 }, // 30d hard cap; refresh keeps the access token live within it
      );
    },
    async get(tenant, shopperId) {
      const key = await getKey();
      if (!key) return null;
      const doc = await store.get<{ c?: string }>({ tenantId: tenant }, GRANTS, shopperId);
      if (!doc || typeof doc.c !== "string") return null;
      const pt = decrypt(key, doc.c);
      if (!pt) return null;
      try {
        return JSON.parse(pt) as StoredGrant;
      } catch {
        return null;
      }
    },
    async delete(tenant, shopperId) {
      await store.delete({ tenantId: tenant }, GRANTS, shopperId);
    },
  };
}

// exported for a round-trip / tamper-detection test only
export const __test = { encrypt, decrypt };
