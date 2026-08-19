import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

function git(args: string[]): string {
  const out = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (out.error) throw out.error;
  if (out.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${out.stderr}`);
  return out.stdout;
}

/** Every path this branch has touched relative to `main`, INCLUDING uncommitted working-tree changes
 *  and untracked new files — so this test is meaningful whether run before or after `git commit`. */
function changedPaths(): string[] {
  const mergeBase = git(["merge-base", "main", "HEAD"]).trim();
  const tracked = git(["diff", "--name-only", mergeBase]).split("\n");
  const untracked = git(["ls-files", "--others", "--exclude-standard"]).split("\n");
  return [...tracked, ...untracked].map((p) => p.trim()).filter(Boolean);
}

describe("W2-C — shopify.app.toml is untouched and grants no new scope", () => {
  it("shopify.app.toml is not among the files this branch changed", () => {
    expect(changedPaths()).not.toContain("shopify.app.toml");
  });

  it("shopify.app.toml (as it exists on disk right now) does not declare read_orders or any order/customer scope", () => {
    const toml = readFileSync(join(repoRoot, "shopify.app.toml"), "utf8");
    const scopesLine = toml.split("\n").find((l) => l.trim().startsWith("scopes ="));
    expect(scopesLine, "shopify.app.toml must declare an [access_scopes] scopes line").toBeDefined();
    expect(scopesLine).not.toMatch(/read_orders|write_orders|read_customers|write_customers/);
  });
});

describe("W2-C — no widget file changed", () => {
  it("nothing under packages/widget/ is among the files this branch changed", () => {
    const widgetFiles = changedPaths().filter((p) => p.startsWith("packages/widget/"));
    expect(widgetFiles, `expected no packages/widget/ changes, found: ${JSON.stringify(widgetFiles)}`).toEqual([]);
  });
});
