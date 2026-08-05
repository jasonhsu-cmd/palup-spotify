import { describe, it, expect } from "vitest";
import type { CryptoPort } from "../crypto-port.js";

// Port contract (ADR-0001): every CryptoPort adapter (this local AES-256-GCM one, a future cloud-KMS
// envelope adapter, …) MUST pass this, so adapters stay behavior-equivalent and swappable behind the
// port (ADR-0015 Inv 9's encryption-at-rest requirement never depends on which adapter is wired in).
//
// `make()` must return a FRESH adapter each call, configured so tenant "keyed-tenant" HAS a key and
// tenant "no-key-tenant" does NOT (so the contract can exercise both the happy path and the fail-closed
// "no key configured" path without every adapter re-deriving its own fixture). It must ALSO configure
// key material for "keyed-tenant" under key scope `CONTRACT_KEY_SCOPE`, and must NOT configure any for
// `CONTRACT_UNCONFIGURED_KEY_SCOPE` — see the key-scope block at the bottom.
//
// Every call below threads an `aad` (additional authenticated data — a caller's own record-identity
// string) through encrypt/decrypt: binding ciphertext to record identity (security review, finding 4) is
// a PORT-LEVEL guarantee every adapter must honor, not just this local one.

/** Key scope the fixture MUST provision key material for (any adapter, any backing store). */
export const CONTRACT_KEY_SCOPE = "contract-scope";
/** Key scope the fixture MUST NOT provision — used to prove an unconfigured scope fails closed. */
export const CONTRACT_UNCONFIGURED_KEY_SCOPE = "no-such-scope";

export function runCryptoPortContract(make: () => CryptoPort): void {
  describe("CryptoPort contract", () => {
    it("round-trips plaintext through encrypt/decrypt for a tenant with a configured key", async () => {
      const c = make();
      const envelope = await c.encrypt("keyed-tenant", "shopper has a tree-nut allergy", "record-1|text");
      expect(await c.decrypt("keyed-tenant", envelope, "record-1|text")).toBe("shopper has a tree-nut allergy");
    });

    it("the envelope never contains the plaintext in the clear", async () => {
      const c = make();
      const envelope = await c.encrypt("keyed-tenant", "shopper has a tree-nut allergy", "record-1|text");
      expect(envelope).not.toContain("tree-nut");
      expect(envelope).not.toContain("allergy");
    });

    it("two encryptions of the same plaintext are NOT byte-identical (fresh nonce each call)", async () => {
      const c = make();
      const a = await c.encrypt("keyed-tenant", "same fact", "record-1|text");
      const b = await c.encrypt("keyed-tenant", "same fact", "record-2|text");
      expect(a).not.toBe(b);
      expect(await c.decrypt("keyed-tenant", a, "record-1|text")).toBe("same fact");
      expect(await c.decrypt("keyed-tenant", b, "record-2|text")).toBe("same fact");
    });

    it("encrypt THROWS (fail closed) for a tenant with no key configured", async () => {
      const c = make();
      await expect(c.encrypt("no-key-tenant", "anything", "record-1|text")).rejects.toThrow();
    });

    it("decrypt returns undefined (never throws) for a tenant with no key configured", async () => {
      const c = make();
      const envelope = await c.encrypt("keyed-tenant", "some fact", "record-1|text");
      await expect(c.decrypt("no-key-tenant", envelope, "record-1|text")).resolves.toBeUndefined();
    });

    it("decrypt returns undefined (never throws) for a corrupt/foreign-shaped ciphertext", async () => {
      const c = make();
      await expect(c.decrypt("keyed-tenant", "not-an-envelope-at-all", "record-1|text")).resolves.toBeUndefined();
      await expect(
        c.decrypt("keyed-tenant", "v1:only:three:parts:too:many:here", "record-1|text"),
      ).resolves.toBeUndefined();
    });

    it("decrypt returns undefined (never throws) for a tampered envelope (auth tag mismatch)", async () => {
      const c = make();
      const envelope = await c.encrypt("keyed-tenant", "tamper me", "record-1|text");
      const parts = envelope.split(":");
      // Flip the ciphertext payload (the LAST part) — GCM's auth tag must then fail verification.
      const tampered = [...parts.slice(0, -1), Buffer.from("tampered-bytes-here").toString("base64")].join(":");
      await expect(c.decrypt("keyed-tenant", tampered, "record-1|text")).resolves.toBeUndefined();
    });

    it("decrypt returns undefined when the aad differs from what it was encrypted with (binds ciphertext to record identity — security review finding 4)", async () => {
      const c = make();
      const envelope = await c.encrypt("keyed-tenant", "shopper has a tree-nut allergy", "record-1|text");
      // Simulates the ciphertext being relocated onto a different record or a different field.
      expect(await c.decrypt("keyed-tenant", envelope, "record-2|text")).toBeUndefined();
      expect(await c.decrypt("keyed-tenant", envelope, "record-1|sourceQuote")).toBeUndefined();
      // The original aad still works — proves the failures above are genuinely about the aad, not a
      // generally-broken envelope.
      expect(await c.decrypt("keyed-tenant", envelope, "record-1|text")).toBe("shopper has a tree-nut allergy");
    });

    // --- Key scope (A3): WHICH key encrypted a value, so a per-purpose/per-rotation key can be
    // expressed and a ciphertext can never be read under the wrong one. ---

    it("round-trips under an explicit key scope", async () => {
      const c = make();
      const envelope = await c.encrypt("keyed-tenant", "a delegate token", "grant-1|accessToken", CONTRACT_KEY_SCOPE);
      expect(await c.decrypt("keyed-tenant", envelope, "grant-1|accessToken", CONTRACT_KEY_SCOPE)).toBe("a delegate token");
    });

    it("omitting keyScope is EXACTLY the pre-scope behavior (existing callers keep working)", async () => {
      const c = make();
      // Written without a scope, read without a scope — the whole back-compat guarantee in one line.
      const legacy = await c.encrypt("keyed-tenant", "an ordinary fact", "record-1|text");
      expect(await c.decrypt("keyed-tenant", legacy, "record-1|text")).toBe("an ordinary fact");
    });

    it("a scoped ciphertext is NOT readable on the default (no-scope) path — no silent fallback to the default key", async () => {
      const c = make();
      const scoped = await c.encrypt("keyed-tenant", "a delegate token", "grant-1|accessToken", CONTRACT_KEY_SCOPE);
      expect(await c.decrypt("keyed-tenant", scoped, "grant-1|accessToken")).toBeUndefined();
    });

    it("a default-scope ciphertext is NOT readable under another scope", async () => {
      const c = make();
      const unscoped = await c.encrypt("keyed-tenant", "an ordinary fact", "record-1|text");
      expect(await c.decrypt("keyed-tenant", unscoped, "record-1|text", CONTRACT_KEY_SCOPE)).toBeUndefined();
    });

    it("encrypt THROWS (fail closed) for a scope with no key configured — even though the DEFAULT scope has one", async () => {
      const c = make();
      await expect(
        c.encrypt("keyed-tenant", "anything", "grant-1|accessToken", CONTRACT_UNCONFIGURED_KEY_SCOPE),
      ).rejects.toThrow();
    });

    it("decrypt resolves undefined (never the default key's plaintext) for a scope with no key configured", async () => {
      const c = make();
      const scoped = await c.encrypt("keyed-tenant", "a delegate token", "grant-1|accessToken", CONTRACT_KEY_SCOPE);
      await expect(
        c.decrypt("keyed-tenant", scoped, "grant-1|accessToken", CONTRACT_UNCONFIGURED_KEY_SCOPE),
      ).resolves.toBeUndefined();
    });

    it("a BLANK or malformed scope is an ERROR on both encrypt and decrypt — never coerced into the default", async () => {
      const c = make();
      const scoped = await c.encrypt("keyed-tenant", "a delegate token", "grant-1|accessToken", CONTRACT_KEY_SCOPE);
      // `_` is excluded on purpose: adapters that derive a per-scope key name append the `_previous`
      // rotation suffix to it, and a scope literally named `x_previous` could otherwise alias another
      // scope's outgoing key. See `keyScopeSecretName` in the local adapter.
      for (const bad of ["", "   ", "has:colon", "has space", "UPPER", "has_underscore", "way-too-long".repeat(20)]) {
        await expect(c.encrypt("keyed-tenant", "x", "grant-1|accessToken", bad)).rejects.toThrow();
        // Returning `undefined` here would be the repo's recurring "absent read looks valid" defect: a
        // caller with a typo'd scope would conclude the record is undecryptable and drop it.
        await expect(c.decrypt("keyed-tenant", scoped, "grant-1|accessToken", bad)).rejects.toThrow();
      }
    });

    it("the scope is recorded in the ciphertext (a decrypt can tell which key produced it) and is not the plaintext", async () => {
      const c = make();
      const scoped = await c.encrypt("keyed-tenant", "a delegate token", "grant-1|accessToken", CONTRACT_KEY_SCOPE);
      expect(scoped).toContain(CONTRACT_KEY_SCOPE);
      expect(scoped).not.toContain("delegate token");
    });
  });
}
