import { describe, it, expect } from "vitest";
import { runSecretsPortContract } from "@palup/platform-ports/contract/secrets";
import { createEnvSecrets } from "../src/secrets-port.js";

// The env adapter satisfies the SecretsPort contract (seeded per the contract's convention).
runSecretsPortContract(() => createEnvSecrets(JSON.stringify({ t1: { k: "v1" }, t2: { k2: "v2" } })));

describe("createEnvSecrets", () => {
  it("does not resolve inherited/prototype keys as secrets", async () => {
    const s = createEnvSecrets(JSON.stringify({ t1: { k: "v1" } }));
    expect(await s.get("__proto__", "k")).toBeUndefined();
    expect(await s.get("t1", "toString")).toBeUndefined();
    expect(await s.get("constructor", "k")).toBeUndefined();
  });

  it("tolerates malformed / missing config (returns undefined, no throw)", async () => {
    expect(await createEnvSecrets("not json").get("t1", "k")).toBeUndefined();
    expect(await createEnvSecrets(undefined).get("t1", "k")).toBeUndefined();
  });

  it("ignores non-string and empty secret values (empty ⇒ unset, never a live credential)", async () => {
    const s = createEnvSecrets(JSON.stringify({ t1: { k: 123, blank: "", ok: "yes" } }));
    expect(await s.get("t1", "k")).toBeUndefined();
    expect(await s.get("t1", "blank")).toBeUndefined();
    expect(await s.get("t1", "ok")).toBe("yes");
  });
});
