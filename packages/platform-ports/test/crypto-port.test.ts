import { describe, it, expect } from "vitest";
import { CONTRACT_KEY_SCOPE, runCryptoPortContract } from "@palup/platform-ports/contract/crypto";
import { createAesGcmCrypto, keyScopeSecretName } from "../src/crypto-port.js";
import { createEnvSecrets } from "../src/secrets-port.js";

// ADR-0015 Inv 9 (go-live blocker #2 — encryption at rest for special-category facts). `createAesGcmCrypto`
// is the local default CryptoPort adapter, keyed per-tenant from SecretsPort; a future cloud-KMS adapter
// swaps in behind the SAME port (ADR-0001) and must pass the SAME contract below.

function makeKeyedCrypto() {
  const secrets = createEnvSecrets(
    JSON.stringify({
      "keyed-tenant": {
        MEMORY_ENCRYPTION_KEY: "a-test-passphrase-for-keyed-tenant",
        // The contract's key-scope block requires material for CONTRACT_KEY_SCOPE and NONE for
        // CONTRACT_UNCONFIGURED_KEY_SCOPE. In this adapter a scope selects its own SecretsPort name, so
        // an operator can provision (and rotate) each scope's key independently.
        [keyScopeSecretName("MEMORY_ENCRYPTION_KEY", CONTRACT_KEY_SCOPE)]: "a-test-passphrase-for-the-contract-scope",
      },
    }),
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

describe("createAesGcmCrypto — key scope (A3)", () => {
  const KEY_A = "material-for-the-default-scope-x";
  const KEY_B = "material-for-the-grant-scope-yy";
  const GRANT_SCOPE = "caa-grant";

  function scopedCrypto(defaultMaterial: string, scopeMaterial: string | undefined) {
    const inner: Record<string, string> = { MEMORY_ENCRYPTION_KEY: defaultMaterial };
    if (scopeMaterial) inner[keyScopeSecretName("MEMORY_ENCRYPTION_KEY", GRANT_SCOPE)] = scopeMaterial;
    return createAesGcmCrypto(createEnvSecrets(JSON.stringify({ acme: inner })));
  }

  it("the default (no-scope) envelope format is UNCHANGED — `v1:` with 5 parts, so already-stored rows still read", async () => {
    const c = scopedCrypto(KEY_A, KEY_B);
    const envelope = await c.encrypt("acme", "an ordinary fact", "record-1|text");
    expect(envelope.split(":")).toHaveLength(5);
    expect(envelope.startsWith("v1:")).toBe(true);
    expect(await c.decrypt("acme", envelope, "record-1|text")).toBe("an ordinary fact");
  });

  it("an explicitly scoped envelope is `v2:<scope>:…` — self-describing, so a decrypt can select the key", async () => {
    const c = scopedCrypto(KEY_A, KEY_B);
    const envelope = await c.encrypt("acme", "a delegate token", "grant-1|accessToken", GRANT_SCOPE);
    const parts = envelope.split(":");
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe("v2");
    expect(parts[1]).toBe(GRANT_SCOPE);
  });

  it("a scope selects its OWN SecretsPort key: an unconfigured scope fails closed even though the default key is present", async () => {
    const c = scopedCrypto(KEY_A, undefined); // default configured, GRANT_SCOPE not
    await expect(c.encrypt("acme", "a delegate token", "grant-1|accessToken", GRANT_SCOPE)).rejects.toThrow(/fail closed/i);
    // …and the default path is unaffected, proving the refusal is about the SCOPE, not the tenant.
    await expect(c.encrypt("acme", "an ordinary fact", "record-1|text")).resolves.toBeTruthy();
  });

  it("a no-key-for-scope error names the scope and the secret it looked for, and leaks no key material", async () => {
    const c = scopedCrypto(KEY_A, undefined);
    let message = "";
    try {
      await c.encrypt("acme", "a delegate token", "grant-1|accessToken", GRANT_SCOPE);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(GRANT_SCOPE);
    expect(message).toContain(keyScopeSecretName("MEMORY_ENCRYPTION_KEY", GRANT_SCOPE));
    expect(message).not.toContain(KEY_A);
    expect(message).not.toContain(KEY_B);
  });

  it("two scopes provisioned with IDENTICAL raw material are STILL not cross-decryptable (the scope is bound into the GCM aad)", async () => {
    const same = "the-exact-same-shared-secret-value";
    const c = createAesGcmCrypto(
      createEnvSecrets(
        JSON.stringify({
          acme: {
            MEMORY_ENCRYPTION_KEY: same,
            [keyScopeSecretName("MEMORY_ENCRYPTION_KEY", GRANT_SCOPE)]: same,
            [keyScopeSecretName("MEMORY_ENCRYPTION_KEY", "other-scope")]: same,
          },
        }),
      ),
    );
    const scoped = await c.encrypt("acme", "a delegate token", "grant-1|accessToken", GRANT_SCOPE);
    // Identical key BYTES, so only the aad binding can refuse this. Without it, a misconfigured operator
    // would silently get cross-purpose decryption.
    expect(await c.decrypt("acme", scoped, "grant-1|accessToken", "other-scope")).toBeUndefined();
    expect(await c.decrypt("acme", scoped, "grant-1|accessToken")).toBeUndefined();
    expect(await c.decrypt("acme", scoped, "grant-1|accessToken", GRANT_SCOPE)).toBe("a delegate token");
  });

  it("a scope is still TENANT-scoped: another tenant cannot read the same scope's ciphertext", async () => {
    const secrets = createEnvSecrets(
      JSON.stringify({
        "tenant-a": { [keyScopeSecretName("MEMORY_ENCRYPTION_KEY", GRANT_SCOPE)]: "material-for-tenant-a-scope" },
        "tenant-b": { [keyScopeSecretName("MEMORY_ENCRYPTION_KEY", GRANT_SCOPE)]: "material-for-tenant-b-scope" },
      }),
    );
    const c = createAesGcmCrypto(secrets);
    const envelope = await c.encrypt("tenant-a", "a's delegate token", "grant-1|accessToken", GRANT_SCOPE);
    expect(await c.decrypt("tenant-b", envelope, "grant-1|accessToken", GRANT_SCOPE)).toBeUndefined();
    expect(await c.decrypt("tenant-a", envelope, "grant-1|accessToken", GRANT_SCOPE)).toBe("a's delegate token");
  });

  it("rotation works PER SCOPE via the same `<name>_previous` convention, without touching the default scope's key", async () => {
    const before = createAesGcmCrypto(
      createEnvSecrets(
        JSON.stringify({
          acme: { MEMORY_ENCRYPTION_KEY: KEY_A, [keyScopeSecretName("MEMORY_ENCRYPTION_KEY", GRANT_SCOPE)]: "grant-key-generation-one" },
        }),
      ),
    );
    const envelope = await before.encrypt("acme", "a delegate token", "grant-1|accessToken", GRANT_SCOPE);
    const after = createAesGcmCrypto(
      createEnvSecrets(
        JSON.stringify({
          acme: {
            MEMORY_ENCRYPTION_KEY: KEY_A, // untouched by the scope's rotation
            [keyScopeSecretName("MEMORY_ENCRYPTION_KEY", GRANT_SCOPE)]: "grant-key-generation-two",
            [`${keyScopeSecretName("MEMORY_ENCRYPTION_KEY", GRANT_SCOPE)}_previous`]: "grant-key-generation-one",
          },
        }),
      ),
    );
    expect(await after.decrypt("acme", envelope, "grant-1|accessToken", GRANT_SCOPE)).toBe("a delegate token");
  });

  it("a v2 envelope whose recorded scope differs from the requested one is refused before any key lookup", async () => {
    const c = scopedCrypto(KEY_A, KEY_B);
    const envelope = await c.encrypt("acme", "a delegate token", "grant-1|accessToken", GRANT_SCOPE);
    const forged = ["v2", "other-scope", ...envelope.split(":").slice(2)].join(":");
    expect(await c.decrypt("acme", forged, "grant-1|accessToken", GRANT_SCOPE)).toBeUndefined();
  });

  it("keyScopeSecretName is deterministic, scope-distinct, and never collides with the base name", () => {
    expect(keyScopeSecretName("MEMORY_ENCRYPTION_KEY", "caa-grant")).toBe(keyScopeSecretName("MEMORY_ENCRYPTION_KEY", "caa-grant"));
    expect(keyScopeSecretName("MEMORY_ENCRYPTION_KEY", "caa-grant")).not.toBe(keyScopeSecretName("MEMORY_ENCRYPTION_KEY", "other"));
    expect(keyScopeSecretName("MEMORY_ENCRYPTION_KEY", "caa-grant")).not.toBe("MEMORY_ENCRYPTION_KEY");
    // The rotation convention appends `_previous`; a scope name must not be able to forge that slot.
    expect(() => keyScopeSecretName("MEMORY_ENCRYPTION_KEY", "bad scope")).toThrow();
  });
});

// Opt-in SHARED BASE KEY (self-serve install). When `sharedKeyTenantId` is set and a tenant has NO
// per-tenant key for the requested scope, the adapter derives that tenant's key from a single shared base
// secret (read under the SAME per-scope secret name, held under a reserved non-real-tenant SecretsPort id)
// instead of throwing. Cross-tenant isolation is preserved BY CONSTRUCTION: `deriveKey` mixes tenantId
// into HKDF `info`, so two tenants deriving from the identical shared base still get DIFFERENT AES keys.
// The opt defaults UNDEFINED (off) — behavior is then byte-for-byte today's. Per-tenant keys always win.
describe("createAesGcmCrypto — opt-in shared base key (self-serve install fallback)", () => {
  const SCOPE = "merchant-cred"; // the merchant-credential store's key scope (state-postgres)
  const SHARED_TENANT = "__shared__"; // reserved, non-real-tenant SecretsPort id (real tenants have no leading `_`)
  const sharedSecretName = keyScopeSecretName("MEMORY_ENCRYPTION_KEY", SCOPE); // "MEMORY_ENCRYPTION_KEY__merchant-cred"

  // T1 — opt OFF is byte-for-byte today's behavior.
  it("T1: opt OFF — no per-tenant key throws; a per-tenant key round-trips with the unchanged v1/v2 envelope shape", async () => {
    // No shared opt, no per-tenant key ⇒ fail closed (unchanged).
    const bare = createAesGcmCrypto(createEnvSecrets(undefined));
    await expect(bare.encrypt("brand-new-merchant", "a delegate token", "grant-1|accessToken", SCOPE)).rejects.toThrow(/fail closed/i);

    // A per-tenant key, opt off ⇒ round-trips; default scope stays v1, an explicit scope stays v2.
    const keyed = createAesGcmCrypto(
      createEnvSecrets(
        JSON.stringify({
          acme: {
            MEMORY_ENCRYPTION_KEY: "a-perfectly-fine-default-scope-key",
            [sharedSecretName]: "a-perfectly-fine-merchant-cred-key",
          },
        }),
      ),
    );
    const v1 = await keyed.encrypt("acme", "an ordinary fact", "record-1|text");
    expect(v1.startsWith("v1:")).toBe(true);
    expect(v1.split(":")).toHaveLength(5);
    expect(await keyed.decrypt("acme", v1, "record-1|text")).toBe("an ordinary fact");
    const v2 = await keyed.encrypt("acme", "a delegate token", "grant-1|accessToken", SCOPE);
    expect(v2.startsWith(`v2:${SCOPE}:`)).toBe(true);
    expect(v2.split(":")).toHaveLength(6);
    expect(await keyed.decrypt("acme", v2, "grant-1|accessToken", SCOPE)).toBe("a delegate token");
  });

  // T2 — the shared base lets a brand-new tenant (no per-tenant key) encrypt and round-trip.
  it("T2: shared base enables encrypt for a tenant with NO per-tenant key, and round-trips", async () => {
    const secrets = createEnvSecrets(
      JSON.stringify({ [SHARED_TENANT]: { [sharedSecretName]: "the-single-shared-base-merchant-cred-key" } }),
    );
    const crypto = createAesGcmCrypto(secrets, { sharedKeyTenantId: SHARED_TENANT });
    const envelope = await crypto.encrypt("brand-new-merchant", "a delegate token", "grant-1|accessToken", SCOPE);
    expect(envelope.startsWith(`v2:${SCOPE}:`)).toBe(true);
    expect(await crypto.decrypt("brand-new-merchant", envelope, "grant-1|accessToken", SCOPE)).toBe("a delegate token");
  });

  // T3 — CRITICAL cross-tenant isolation: identical shared base, DIFFERENT derived keys.
  it("T3: two tenants sharing the SAME shared base derive DIFFERENT keys — one's ciphertext never decrypts for the other", async () => {
    const secrets = createEnvSecrets(
      JSON.stringify({ [SHARED_TENANT]: { [sharedSecretName]: "the-single-shared-base-merchant-cred-key" } }),
    );
    const crypto = createAesGcmCrypto(secrets, { sharedKeyTenantId: SHARED_TENANT });
    const acme = await crypto.encrypt("acme", "acme delegate token", "grant-1|accessToken", SCOPE);
    const globex = await crypto.encrypt("globex", "globex delegate token", "grant-1|accessToken", SCOPE);

    // acme's envelope must NOT decrypt under globex's derived key (and vice versa).
    expect(await crypto.decrypt("globex", acme, "grant-1|accessToken", SCOPE)).toBeUndefined();
    expect(await crypto.decrypt("acme", globex, "grant-1|accessToken", SCOPE)).toBeUndefined();
    // Each still decrypts for its own tenant.
    expect(await crypto.decrypt("acme", acme, "grant-1|accessToken", SCOPE)).toBe("acme delegate token");
    expect(await crypto.decrypt("globex", globex, "grant-1|accessToken", SCOPE)).toBe("globex delegate token");
    // The derived keyId embedded in the two envelopes differs — proof the keys are distinct, not luck.
    expect(acme.split(":")[2]).not.toBe(globex.split(":")[2]);
  });

  // T4 — per-tenant precedence over the shared base.
  it("T4: a per-tenant key takes precedence over the shared base, and its ciphertext survives the shared base being removed", async () => {
    const withBoth = createAesGcmCrypto(
      createEnvSecrets(
        JSON.stringify({
          acme: { [sharedSecretName]: "acme-own-per-tenant-merchant-cred-key" },
          [SHARED_TENANT]: { [sharedSecretName]: "the-single-shared-base-merchant-cred-key" },
        }),
      ),
      { sharedKeyTenantId: SHARED_TENANT },
    );
    const envelope = await withBoth.encrypt("acme", "a delegate token", "grant-1|accessToken", SCOPE);
    expect(await withBoth.decrypt("acme", envelope, "grant-1|accessToken", SCOPE)).toBe("a delegate token");

    // Remove the shared base entirely — the envelope was written under acme's OWN key, so it still reads.
    const perTenantOnly = createAesGcmCrypto(
      createEnvSecrets(JSON.stringify({ acme: { [sharedSecretName]: "acme-own-per-tenant-merchant-cred-key" } })),
    );
    expect(await perTenantOnly.decrypt("acme", envelope, "grant-1|accessToken", SCOPE)).toBe("a delegate token");
  });

  // T5 — scope isolation: a merchant-cred shared base never serves the default scope.
  it("T5: the shared base is per-scope — a default-scope encrypt with no default key STILL throws", async () => {
    const secrets = createEnvSecrets(
      JSON.stringify({ [SHARED_TENANT]: { [sharedSecretName]: "the-single-shared-base-merchant-cred-key" } }),
    );
    const crypto = createAesGcmCrypto(secrets, { sharedKeyTenantId: SHARED_TENANT });
    // No default-scope per-tenant key and no default-scope shared base ⇒ fail closed (no cross-scope leak).
    await expect(crypto.encrypt("brand-new-merchant", "an ordinary fact", "record-1|text")).rejects.toThrow(/fail closed/i);
    // …while the merchant-cred scope IS served, proving the refusal is about the scope, not the tenant.
    await expect(crypto.encrypt("brand-new-merchant", "a delegate token", "grant-1|accessToken", SCOPE)).resolves.toBeTruthy();
  });

  // T6 — fail closed when neither a per-tenant key nor the shared base is configured.
  it("T6: opt ON but the shared base secret is ALSO absent (and no per-tenant key) ⇒ encrypt throws", async () => {
    const crypto = createAesGcmCrypto(createEnvSecrets(undefined), { sharedKeyTenantId: SHARED_TENANT });
    await expect(crypto.encrypt("brand-new-merchant", "a delegate token", "grant-1|accessToken", SCOPE)).rejects.toThrow(/fail closed/i);
  });

  // T7 — migration robustness: shared-base ciphertext stays readable after a per-tenant key is added.
  it("T7: a token encrypted under the shared base still decrypts after a per-tenant key is later provisioned", async () => {
    const sharedOnly = createAesGcmCrypto(
      createEnvSecrets(JSON.stringify({ [SHARED_TENANT]: { [sharedSecretName]: "the-single-shared-base-merchant-cred-key" } })),
      { sharedKeyTenantId: SHARED_TENANT },
    );
    const envelope = await sharedOnly.encrypt("acme", "a delegate token", "grant-1|accessToken", SCOPE);

    // Operator later provisions acme its OWN key. currentKey now prefers the per-tenant key, but the
    // shared-base candidate must keep the pre-existing envelope readable.
    const afterProvision = createAesGcmCrypto(
      createEnvSecrets(
        JSON.stringify({
          acme: { [sharedSecretName]: "acme-own-per-tenant-merchant-cred-key" },
          [SHARED_TENANT]: { [sharedSecretName]: "the-single-shared-base-merchant-cred-key" },
        }),
      ),
      { sharedKeyTenantId: SHARED_TENANT },
    );
    expect(await afterProvision.decrypt("acme", envelope, "grant-1|accessToken", SCOPE)).toBe("a delegate token");
  });

  // T8 — the entropy floor applies to the shared base too.
  it("T8: a shared base shorter than the entropy floor ⇒ encrypt throws", async () => {
    const secrets = createEnvSecrets(JSON.stringify({ [SHARED_TENANT]: { [sharedSecretName]: "short" } }));
    const crypto = createAesGcmCrypto(secrets, { sharedKeyTenantId: SHARED_TENANT });
    await expect(crypto.encrypt("brand-new-merchant", "a delegate token", "grant-1|accessToken", SCOPE)).rejects.toThrow(/minimum|entropy/i);
  });
});
