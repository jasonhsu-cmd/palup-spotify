import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore, createCachingGroundingPort, type GroundingPort } from "@palup/platform-ports";
import { StaticGroundingAdapter } from "@palup/widget-brain";

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
