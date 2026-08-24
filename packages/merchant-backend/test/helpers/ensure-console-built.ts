import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

// server.ts serves the `@palup/merchant-console` Vite bundle straight off disk from
// `packages/merchant-console/dist-web`. That dir is gitignored build output (like `dist/`), so a fresh
// checkout won't have it — and without it, `GET /`/`/index.html` fall to server.ts's 503
// "console_not_built" branch instead of 200, which would make `route-protection.test.ts`'s exemption
// assertion and `console-serve.test.ts`'s SPA-serving assertions fail for a reason that has nothing to
// do with the auth logic either file is actually testing. Both files call this in a `beforeAll` so
// `pnpm exec vitest run packages/merchant-backend` alone (no separate `pnpm --filter
// @palup/merchant-console build` step first) is still green from a clean checkout.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const consoleIndexPath = join(repoRoot, "packages", "merchant-console", "dist-web", "index.html");

export function ensureConsoleBuilt(): void {
  if (existsSync(consoleIndexPath)) return;
  execSync("pnpm --filter @palup/merchant-console build", { cwd: repoRoot, stdio: "inherit" });
  if (!existsSync(consoleIndexPath)) {
    throw new Error(`merchant-console build ran but ${consoleIndexPath} still doesn't exist`);
  }
}
