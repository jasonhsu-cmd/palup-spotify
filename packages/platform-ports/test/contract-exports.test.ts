import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// WHY THIS EXISTS. `merchant-registry-port.contract.ts` shipped (#178) without an `exports` entry in this
// package's package.json — the only one of eight contract files missing one. Nothing failed: the port's own
// test uses a relative import, so the gap was invisible until a DIFFERENT package tried
// `@palup/platform-ports/contract/merchant-registry`, which is how every cross-package contract import
// works (e.g. `packages/state-postgres/test/postgres-runtime-store.test.ts` imports
// `@palup/platform-ports/contract/runtime-state`). The next consumer would have hit an opaque resolution
// error far from the cause.
//
// The authoring PR flagged it as out-of-lane rather than silently leaving it, which is why it was caught at
// all. This test is the part that generalises: a contract file with no subpath export is an unusable
// contract, so make that a failing test rather than a thing someone has to remember.

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
  exports: Record<string, string>;
};

describe("every port contract is importable cross-package", () => {
  const contractFiles = readdirSync(join(pkgDir, "src", "contract")).filter((f) => f.endsWith(".contract.ts"));

  it("finds the contract files at all (guards against a moved directory)", () => {
    expect(contractFiles.length).toBeGreaterThan(5);
  });

  it.each(contractFiles)("%s has an exports entry", (file) => {
    const target = `./src/contract/${file}`;
    const entries = Object.entries(pkg.exports).filter(([, v]) => v === target);
    expect(
      entries.length,
      `no "exports" subpath maps to ${target} — add one to packages/platform-ports/package.json, ` +
        `or a cross-package \`@palup/platform-ports/contract/...\` import of it will fail to resolve`,
    ).toBeGreaterThan(0);
  });

  it("every exports subpath points at a file that exists (no dangling entry)", () => {
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      if (!target.includes("/contract/")) continue;
      const name = target.replace("./src/contract/", "");
      expect(contractFiles, `exports "${subpath}" -> ${target}, which does not exist`).toContain(name);
    }
  });
});
