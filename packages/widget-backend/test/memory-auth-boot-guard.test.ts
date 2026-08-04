import { describe, it, expect, vi, afterEach } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";

// Go-live #3 — proves `buildServer` itself wires `assertMemoryAuthCoupling` against the REAL
// `isMemoryEnabled()` double gate (not just the PR-8 `memoryEnabled` test seam other memory tests use —
// that seam deliberately does NOT trip this guard, since it exists to let OTHER tests exercise
// remember()/recall() without also standing up widget-token auth). `isMemoryEnabled` is mocked here
// (flag.ts's MEMORY_ADR_ACCEPTED is never touched — this stays a code-level mock local to this test
// file, not a change to the real double gate) so the boot-time guard can be exercised end-to-end without
// waiting on the separate, reviewed ADR-flip PR.
vi.mock("@palup/widget-memory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@palup/widget-memory")>();
  return { ...actual, isMemoryEnabled: () => true };
});

const { buildServer } = await import("../src/server.js");

const ENV_KEYS = ["WIDGET_AUTH_REQUIRED"];
afterEach(() => ENV_KEYS.forEach((k) => delete process.env[k]));

describe("boot fails fast when memory is live (real isMemoryEnabled()) without enforced widget auth", () => {
  it("buildServer rejects when WIDGET_AUTH_REQUIRED is not \"true\"", async () => {
    await expect(buildServer({ store: new InMemoryRuntimeStore() })).rejects.toThrow(/WIDGET_AUTH_REQUIRED/);
  });

  it("buildServer boots fine once WIDGET_AUTH_REQUIRED=true", async () => {
    process.env.WIDGET_AUTH_REQUIRED = "true";
    const app = await buildServer({ store: new InMemoryRuntimeStore() });
    await app.close();
  });
});
