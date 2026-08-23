import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { INSTALL_SCOPES_DEFAULT } from "../src/routes/shopify-install.js";
import { ORDER_ATTRIBUTION_ADMIN_SCOPE } from "../src/shopify-webhook-identity.js";

// Scope-pinning guard for the SPLIT Shopify app config (2026-08-23: staging + prod are SEPARATE apps; the
// single old app was deleted). Enforces the env split the owner set:
//   • STAGING (`shopify.app.staging.toml`) may carry the broad autonomous-testing scope set — but ONLY from
//     a fixed allowlist, so any FURTHER scope creep still fails CI.
//   • PRODUCTION (`shopify.app.production.toml`, DEFERRED — may not exist yet) may declare ONLY the minimal
//     real-feature scopes (read_products,read_inventory); never a write/customer/order/read_all_orders
//     scope. `read_orders` (order attribution) reaches prod ONLY via the per-deployment
//     `SHOPIFY_INSTALL_SCOPES` env var (W3-3 below), never the static prod toml.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function scopesOf(tomlPath: string): string[] {
  const line = readFileSync(tomlPath, "utf8")
    .split("\n")
    .find((l) => l.trim().startsWith("scopes ="));
  expect(line, `${tomlPath} must declare an [access_scopes] scopes line`).toBeDefined();
  return (line!.split('"')[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

describe("shopify STAGING app declares only the allowed autonomous-testing scope set (anti-creep)", () => {
  it("staging scopes are all within the fixed testing allowlist", () => {
    const scopes = scopesOf(join(repoRoot, "shopify.app.staging.toml"));
    const ALLOWED = new Set(["read_products", "read_inventory", "write_customers", "write_orders", "read_all_orders"]);
    const unexpected = scopes.filter((s) => !ALLOWED.has(s));
    expect(unexpected, `un-allowlisted scope(s) in shopify.app.staging.toml: ${unexpected.join(", ")}`).toEqual([]);
  });
});

describe("shopify PRODUCTION app (deferred) stays least-privilege — no write/order/customer scope", () => {
  it("prod toml, once it exists, declares only read_products/read_inventory", () => {
    const prodToml = join(repoRoot, "shopify.app.production.toml");
    if (!existsSync(prodToml)) return; // DEFERRED: prod app/config not yet created — nothing to assert yet
    const scopes = scopesOf(prodToml);
    const MINIMAL = new Set(["read_products", "read_inventory"]);
    const forbidden = scopes.filter((s) => !MINIMAL.has(s));
    expect(forbidden, `shopify.app.production.toml must stay least-privilege; forbidden scope(s): ${forbidden.join(", ")}`).toEqual([]);
  });
});

// W3-3 — `read_orders` (order attribution) is requested, if ever, via the OPERATOR-CONTROLLED, per-deployment
// `SHOPIFY_INSTALL_SCOPES` env var (server.ts, docs/DEPLOY.md) — NEVER via a static `[access_scopes]`. This
// pins the CODE-LEVEL default so a deployment that sets nothing new never requests it.
describe("W3-3 — read_orders is requested only via the per-deployment SHOPIFY_INSTALL_SCOPES env var", () => {
  it("INSTALL_SCOPES_DEFAULT (the code-level default Admin OAuth `scope` request) does not include read_orders", () => {
    expect(INSTALL_SCOPES_DEFAULT.split(",").map((s) => s.trim())).not.toContain(ORDER_ATTRIBUTION_ADMIN_SCOPE);
  });

  it("ORDER_ATTRIBUTION_ADMIN_SCOPE names exactly the one scope order-attribution needs (read_orders)", () => {
    expect(ORDER_ATTRIBUTION_ADMIN_SCOPE).toBe("read_orders");
  });
});
