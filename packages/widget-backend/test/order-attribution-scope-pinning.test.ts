import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { INSTALL_SCOPES_DEFAULT } from "../src/routes/shopify-install.js";
import { ORDER_ATTRIBUTION_ADMIN_SCOPE } from "../src/shopify-webhook-identity.js";

// W2-C — CRITICAL CONSTRAINTS, pinned so a later change cannot silently cross either boundary this
// work item was explicitly told never to touch:
//   1. `shopify.app.toml` must not gain `read_orders` (or any other new scope) — granting it, and
//      completing Shopify's protected-customer-data review, is an OWNER-gated step outside a build
//      agent's authority (see routes/shopify-webhooks.ts's W2-C header).
//   2. Nothing under `packages/widget/` changed — the widget-side cart `note_attribute` wiring is a
//      SEPARATE, explicitly out-of-scope change owned by a different session.
//
// This mirrors packages/eval/test/suite-gate.test.ts's own precedent for shelling out (`spawnSync`) to
// assert something a plain unit test can't: the actual committed+working-tree diff against `main`.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// W2-C (LOOSENED 2026-08-23, owner-authorized — jason): the original pins here were "shopify.app.toml is
// untouched" and "declares NO order/customer scope", labeled an OWNER-gated step outside a build agent's
// authority. The owner has now gated it: the DEV Dashboard app declares `write_customers,write_orders` to
// seed test-shopper fixtures on the DEVELOPMENT store (see shopify.app.toml's own comment; dev-store apps
// need no Shopify PCD review). PRODUCTION will be a SEPARATE app, so these scopes must not reach prod. The
// anti-scope-CREEP intent is PRESERVED as an exact allowlist below — any scope beyond the four authorized
// ones (incl. read_all_orders or a standalone read_orders) still fails CI. The old `changedPaths()` "toml
// untouched" pin is retired (the toml is now intentionally changed) — the disk-state allowlist is stronger.
describe("shopify.app.toml declares only the owner-authorized scope set (anti-creep)", () => {
  it("declares exactly the allowed scopes — no un-authorized order/customer/creep scope", () => {
    const toml = readFileSync(join(repoRoot, "shopify.app.toml"), "utf8");
    const scopesLine = toml.split("\n").find((l) => l.trim().startsWith("scopes ="));
    expect(scopesLine, "shopify.app.toml must declare an [access_scopes] scopes line").toBeDefined();
    const scopes = (scopesLine.split('"')[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const ALLOWED = new Set(["read_products", "read_inventory", "write_customers", "write_orders"]);
    const unexpected = scopes.filter((s) => !ALLOWED.has(s));
    expect(unexpected, `un-authorized scope(s) in shopify.app.toml (owner-gated): ${unexpected.join(", ")}`).toEqual([]);
    // Belt-and-braces on the two escalations we explicitly did NOT authorize:
    expect(scopes).not.toContain("read_all_orders");
    expect(scopes).not.toContain("read_orders"); // write_orders already includes read; a standalone read_orders is not wanted
  });
});

// W2-C — RETIRED (2026-08-19): the "nothing under packages/widget/ changed" pin was a REVIEW-TIME scope
// guard for the W2-C PR (whose widget-side cart note_attribute wiring was out of scope, owned by another
// session). W2-C is merged, so this blanket guard now only false-fails ANY later legitimate widget change
// (e.g. the Pillar 3 opener chips UI) against a base it no longer describes. Retired here; the invariants
// that still matter — shopify.app.toml grants no new read_orders/customer scope (describe above), and
// read_orders is requested only via SHOPIFY_INSTALL_SCOPES, never a code default (W3-3 below) — are untouched.

// ---------------------------------------------------------------------------------------------------
// W3-3 — the `read_orders` DECISION this ticket had to make, pinned so it cannot silently drift:
// `read_orders` is requested (if ever) via the OPERATOR-CONTROLLED, per-deployment `SHOPIFY_INSTALL_SCOPES`
// env var (server.ts, docs/DEPLOY.md) — NEVER via shopify.app.toml's static `[access_scopes]`, which is
// shared across every deployment INCLUDING a not-yet-deployed production one. The two describes above
// already pin half of this (the toml itself); this section pins the other half — the CODE-LEVEL default
// a deployment gets when it sets NOTHING new never requests this scope, so prod's OAuth authorize request
// stays byte-identical to before this ticket unless an operator deliberately opts a SPECIFIC deployment in.
describe("W3-3 — read_orders is requested only via the per-deployment SHOPIFY_INSTALL_SCOPES env var, never a code default", () => {
  it("INSTALL_SCOPES_DEFAULT (the code-level default Admin OAuth `scope` request) does not include read_orders", () => {
    const scopes = INSTALL_SCOPES_DEFAULT.split(",").map((s) => s.trim());
    expect(scopes).not.toContain(ORDER_ATTRIBUTION_ADMIN_SCOPE);
  });

  it("ORDER_ATTRIBUTION_ADMIN_SCOPE names exactly the one scope order-attribution webhook subscriptions need (read_orders)", () => {
    // Pinned so a future rename/typo of this documentation constant is caught by a test rather than only
    // discovered against a live Shopify `userErrors` response.
    expect(ORDER_ATTRIBUTION_ADMIN_SCOPE).toBe("read_orders");
  });

  it("shopify.app.toml declares no order/customer scope (reasserted here, alongside the W3-3 decision it grounds)", () => {
    const toml = readFileSync(join(repoRoot, "shopify.app.toml"), "utf8");
    const scopesLine = toml.split("\n").find((l) => l.trim().startsWith("scopes ="));
    expect(scopesLine, "shopify.app.toml must declare an [access_scopes] scopes line").toBeDefined();
    expect(scopesLine).not.toContain(ORDER_ATTRIBUTION_ADMIN_SCOPE);
  });
});
