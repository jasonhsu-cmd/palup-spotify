import { describe, it, expect } from "vitest";
import { runCryptoPortContract } from "@palup/platform-ports/contract/crypto";
import { createAesGcmCrypto } from "../src/crypto-port.js";
import { createEnvSecrets } from "../src/secrets-port.js";

// ADR-0015 Inv 9 (go-live blocker #2 — encryption at rest for special-category facts). `createAesGcmCrypto`
// is the local default CryptoPort adapter, keyed per-tenant from SecretsPort; a future cloud-KMS adapter
// swaps in behind the SAME port (ADR-0001) and must pass the SAME contract below.

function makeKeyedCrypto() {
  const secrets = createEnvSecrets(
    JSON.stringify({ "keyed-tenant": { MEMORY_ENCRYPTION_KEY: "a-test-passphrase-for-keyed-tenant" } }),
  );
  return createAesGcmCrypto(secrets);
}

runCryptoPortContract(makeKeyedCrypto);

describe("createAesGcmCrypto — adapter-specific behavior", () => {
  it("is tenant-scoped: a ciphertext encrypted for one tenant does not decrypt under a DIFFERENT tenant's key", async () => {
    const secrets = createEnvSecrets(
      JSON.stringify({
        "tenant-a": { MEMORY_ENCRYPTION_KEY: "key-for-tenant-a" },
        "tenant-b": { MEMORY_ENCRYPTION_KEY: "key-for-tenant-b" },
      }),
    );
    const crypto = createAesGcmCrypto(secrets);
    const envelope = await crypto.encrypt("tenant-a", "a's secret fact", "record-1|text");
    expect(await crypto.decrypt("tenant-b", envelope, "record-1|text")).toBeUndefined();
    expect(await crypto.decrypt("tenant-a", envelope, "record-1|text")).toBe("a's secret fact");
  });

  it("security review finding 3 — two tenants provisioned with the IDENTICAL raw secret still get DIFFERENT derived keys (tenantId is mixed into HKDF info)", async () => {
    const secrets = createEnvSecrets(
      JSON.stringify({
        "tenant-x": { MEMORY_ENCRYPTION_KEY: "the-exact-same-shared-secret-value" },
        "tenant-y": { MEMORY_ENCRYPTION_KEY: "the-exact-same-shared-secret-value" },
      }),
    );
    const crypto = createAesGcmCrypto(secrets);
    const envelope = await crypto.encrypt("tenant-x", "tenant-x's secret fact", "record-1|text");
    // Under the prior unsalted single-round SHA-256 KDF (no tenant binding), tenant-y would derive the
    // IDENTICAL key from the identical raw secret and this decrypt would have SUCCEEDED — falsifying the
    // tenant-isolation claim. With tenantId mixed into HKDF's `info`, it must fail.
    expect(await crypto.decrypt("tenant-y", envelope, "record-1|text")).toBeUndefined();
    expect(await crypto.decrypt("tenant-x", envelope, "record-1|text")).toBe("tenant-x's secret fact");
  });

  it("security review finding 3 — encrypt throws when the configured key material is below the entropy floor", async () => {
    const secrets = createEnvSecrets(JSON.stringify({ "acme-short": { MEMORY_ENCRYPTION_KEY: "short" } }));
    const crypto = createAesGcmCrypto(secrets);
    await expect(crypto.encrypt("acme-short", "x", "record-1|text")).rejects.toThrow(/minimum|entropy/i);
  });

  it("security review finding 4 — decrypt fails when the aad differs (ciphertext relocated to a different record/field), even with the right tenant/key", async () => {
    const secrets = createEnvSecrets(JSON.stringify({ "acme-aad": { MEMORY_ENCRYPTION_KEY: "a-perfectly-fine-test-key-value" } }));
    const crypto = createAesGcmCrypto(secrets);
    const envelope = await crypto.encrypt("acme-aad", "shopper has a tree-nut allergy", "record-1|text");
    expect(await crypto.decrypt("acme-aad", envelope, "record-2|text")).toBeUndefined();
    expect(await crypto.decrypt("acme-aad", envelope, "record-1|sourceQuote")).toBeUndefined();
  });

  it("security review finding 5 — a rotated key remains decryptable when the outgoing secret is kept at <name>_previous (rotation is recoverable, not silent mass data loss)", async () => {
    const before = createAesGcmCrypto(
      createEnvSecrets(JSON.stringify({ "acme-rot": { MEMORY_ENCRYPTION_KEY: "the-original-encryption-key-v1" } })),
    );
    const envelope = await before.encrypt("acme-rot", "shopper has a tree-nut allergy", "record-1|text");

    // Rotate: the old value moves to `<name>_previous`; a brand-new value becomes current.
    const after = createAesGcmCrypto(
      createEnvSecrets(
        JSON.stringify({
          "acme-rot": {
            MEMORY_ENCRYPTION_KEY: "the-new-rotated-encryption-key-v2",
            MEMORY_ENCRYPTION_KEY_previous: "the-original-encryption-key-v1",
          },
        }),
      ),
    );
    // The OLD envelope still decrypts (via the previous-key fallback) ...
    expect(await after.decrypt("acme-rot", envelope, "record-1|text")).toBe("shopper has a tree-nut allergy");
    // ... and a FRESH encryption after rotation is unreadable under the OLD key alone.
    const freshEnvelope = await after.encrypt("acme-rot", "a fresh fact", "record-2|text");
    const oldKeyOnly = createAesGcmCrypto(
      createEnvSecrets(JSON.stringify({ "acme-rot": { MEMORY_ENCRYPTION_KEY: "the-original-encryption-key-v1" } })),
    );
    expect(await oldKeyOnly.decrypt("acme-rot", freshEnvelope, "record-2|text")).toBeUndefined();
  });

  it("security review finding 5 — without a kept previous-key secret, records from before a rotation become undecryptable (documented trade-off)", async () => {
    const before = createAesGcmCrypto(
      createEnvSecrets(JSON.stringify({ "acme-rot2": { MEMORY_ENCRYPTION_KEY: "the-original-encryption-key-v1" } })),
    );
    const envelope = await before.encrypt("acme-rot2", "a fact", "record-3|text");
    const afterNoPrevious = createAesGcmCrypto(
      createEnvSecrets(JSON.stringify({ "acme-rot2": { MEMORY_ENCRYPTION_KEY: "the-new-rotated-encryption-key-v2" } })),
    );
    expect(await afterNoPrevious.decrypt("acme-rot2", envelope, "record-3|text")).toBeUndefined();
  });

  it("honors a custom secretName so a caller can provision a distinct key from other tenant secrets", async () => {
    const secrets = createEnvSecrets(JSON.stringify({ acme: { CUSTOM_KEY_NAME: "custom-key-value-16b" } }));
    const crypto = createAesGcmCrypto(secrets, { secretName: "CUSTOM_KEY_NAME" });
    const envelope = await crypto.encrypt("acme", "fact", "record-1|text");
    expect(await crypto.decrypt("acme", envelope, "record-1|text")).toBe("fact");

    // The DEFAULT secret name ("MEMORY_ENCRYPTION_KEY") is NOT configured for this tenant, so an
    // adapter using the default name would fail closed — proving the custom name is actually honored,
    // not merely accepted and ignored.
    const defaultNamedCrypto = createAesGcmCrypto(secrets);
    await expect(defaultNamedCrypto.encrypt("acme", "fact", "record-1|text")).rejects.toThrow();
  });

  it("a no-key error names the tenant/secret but never leaks key material (there is none configured to leak)", async () => {
    const secrets = createEnvSecrets(undefined);
    const crypto = createAesGcmCrypto(secrets);
    let message = "";
    try {
      await crypto.encrypt("unconfigured-tenant", "x", "record-1|text");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("unconfigured-tenant");
    expect(message.toLowerCase()).toContain("fail closed");
  });
});
