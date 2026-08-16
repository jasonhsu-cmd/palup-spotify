import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore, createCachingGroundingPort, type GroundingPort } from "@palup/platform-ports";
import { StaticGroundingAdapter } from "../src/index.js";

// S2 — lives here (not platform-ports/test) because it needs a concrete adapter (StaticGroundingAdapter)
// to run the contract-shaped assertions against. widget-brain already depends on platform-ports (the
// base port layer), so this direction is legal; the reverse (platform-ports depending on widget-brain)
// would be a layering inversion and was removed (see the platform-ports package.json history).
describe("GroundingShell — brand+policy only, no products", () => {
  const adapters: Array<[string, () => GroundingPort]> = [
    ["static", () => new StaticGroundingAdapter()],
    ["caching(static)", () => createCachingGroundingPort(new StaticGroundingAdapter(), new InMemoryRuntimeStore())],
  ];
  for (const [name, make] of adapters) {
    it(`${name}: getShell returns tenant, brand and policy`, async () => {
      const shell = await make().getShell("demo");
      expect(shell.tenantId).toBe("demo");
      expect(shell.brandName.length).toBeGreaterThan(0);
      expect(typeof shell.policy.returns).toBe("string");
      expect(typeof shell.policy.shipping).toBe("string");
      // The shape carries NO products key at all.
      expect("products" in (shell as object)).toBe(false);
    });
  }
});
