import { describe, it, expect } from "vitest";
import type { CryptoPort } from "../crypto-port.js";

// Port contract (ADR-0001): every CryptoPort adapter (this local AES-256-GCM one, a future cloud-KMS
// envelope adapter, …) MUST pass this, so adapters stay behavior-equivalent and swappable behind the
// port (ADR-0015 Inv 9's encryption-at-rest requirement never depends on which adapter is wired in).
//
// `make()` must return a FRESH adapter each call, configured so tenant "keyed-tenant" HAS a key and
// tenant "no-key-tenant" does NOT (so the contract can exercise both the happy path and the fail-closed
// "no key configured" path without every adapter re-deriving its own fixture).
export function runCryptoPortContract(make: () => CryptoPort): void {
  describe("CryptoPort contract", () => {
    it("round-trips plaintext through encrypt/decrypt for a tenant with a configured key", async () => {
      const c = make();
      const envelope = await c.encrypt("keyed-tenant", "shopper has a tree-nut allergy");
      expect(await c.decrypt("keyed-tenant", envelope)).toBe("shopper has a tree-nut allergy");
    });

    it("the envelope never contains the plaintext in the clear", async () => {
      const c = make();
      const envelope = await c.encrypt("keyed-tenant", "shopper has a tree-nut allergy");
      expect(envelope).not.toContain("tree-nut");
      expect(envelope).not.toContain("allergy");
    });

    it("two encryptions of the same plaintext are NOT byte-identical (fresh nonce each call)", async () => {
      const c = make();
      const a = await c.encrypt("keyed-tenant", "same fact");
      const b = await c.encrypt("keyed-tenant", "same fact");
      expect(a).not.toBe(b);
      expect(await c.decrypt("keyed-tenant", a)).toBe("same fact");
      expect(await c.decrypt("keyed-tenant", b)).toBe("same fact");
    });

    it("encrypt THROWS (fail closed) for a tenant with no key configured", async () => {
      const c = make();
      await expect(c.encrypt("no-key-tenant", "anything")).rejects.toThrow();
    });

    it("decrypt returns undefined (never throws) for a tenant with no key configured", async () => {
      const c = make();
      const envelope = await c.encrypt("keyed-tenant", "some fact");
      await expect(c.decrypt("no-key-tenant", envelope)).resolves.toBeUndefined();
    });

    it("decrypt returns undefined (never throws) for a corrupt/foreign-shaped ciphertext", async () => {
      const c = make();
      await expect(c.decrypt("keyed-tenant", "not-an-envelope-at-all")).resolves.toBeUndefined();
      await expect(c.decrypt("keyed-tenant", "v1:only:three:parts:too:many")).resolves.toBeUndefined();
    });

    it("decrypt returns undefined (never throws) for a tampered envelope (auth tag mismatch)", async () => {
      const c = make();
      const envelope = await c.encrypt("keyed-tenant", "tamper me");
      const parts = envelope.split(":");
      // Flip the ciphertext payload — GCM's auth tag must then fail verification.
      const tampered = [parts[0], parts[1], parts[2], Buffer.from("tampered-bytes-here").toString("base64")].join(":");
      await expect(c.decrypt("keyed-tenant", tampered)).resolves.toBeUndefined();
    });
  });
}
