import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOG_TOPICS, COMPLIANCE_TOPICS, UNINSTALL_TOPIC } from "../src/shopify-webhook-identity.js";

describe("shopify.app.toml webhook subscriptions", () => {
  it("shopify.app.toml declares catalog + compliance + uninstall webhook subscriptions", () => {
    // Resolve repo root by going up from the test directory to the repo root
    const repoRoot = join(import.meta.dirname, "../../..");
    const toml = readFileSync(join(repoRoot, "shopify.app.toml"), "utf8");

    // Check that every topic is declared in the TOML
    for (const t of [...CATALOG_TOPICS, ...COMPLIANCE_TOPICS, UNINSTALL_TOPIC]) {
      expect(toml, `missing webhook subscription: ${t}`).toContain(t);
    }

    // Check that api_version is declared
    expect(toml).toMatch(/api_version\s*=/);
  });
});
