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
    const envelope = await crypto.encrypt("tenant-a", "a's secret fact");
    expect(await crypto.decrypt("tenant-b", envelope)).toBeUndefined();
    expect(await crypto.decrypt("tenant-a", envelope)).toBe("a's secret fact");
  });

  it("honors a custom secretName so a caller can provision a distinct key from other tenant secrets", async () => {
    const secrets = createEnvSecrets(JSON.stringify({ acme: { CUSTOM_KEY_NAME: "custom-key-value" } }));
    const crypto = createAesGcmCrypto(secrets, { secretName: "CUSTOM_KEY_NAME" });
    const envelope = await crypto.encrypt("acme", "fact");
    expect(await crypto.decrypt("acme", envelope)).toBe("fact");

    // The DEFAULT secret name ("MEMORY_ENCRYPTION_KEY") is NOT configured for this tenant, so an
    // adapter using the default name would fail closed — proving the custom name is actually honored,
    // not merely accepted and ignored.
    const defaultNamedCrypto = createAesGcmCrypto(secrets);
    await expect(defaultNamedCrypto.encrypt("acme", "fact")).rejects.toThrow();
  });

  it("a no-key error names the tenant/secret but never leaks key material (there is none configured to leak)", async () => {
    const secrets = createEnvSecrets(undefined);
    const crypto = createAesGcmCrypto(secrets);
    let message = "";
    try {
      await crypto.encrypt("unconfigured-tenant", "x");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("unconfigured-tenant");
    expect(message.toLowerCase()).toContain("fail closed");
  });
});
