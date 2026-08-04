import { describe, it, expect, vi, afterEach } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";

// Go-live #3 — proves `buildServer` itself wires `assertMemoryAuthCoupling` against the REAL
// `isMemoryEnabled()` double gate, i.e. the production path, not only the PR-8 `memoryEnabled` test seam.
// (Security review Finding 2 corrected the guard to assert on the SAME effective `memoryServiceEnabled`
// value that actually constructs the MemoryService — which under a test runner INCLUDES that seam. So the
// seam does trip the guard too, and every other memory test now sets WIDGET_AUTH_REQUIRED=true; this file
// covers the real-gate path specifically, so the two can never diverge unnoticed.) `isMemoryEnabled` is
// mocked here — flag.ts's MEMORY_ADR_ACCEPTED is never touched, this stays a code-level mock local to this
// test file — so the boot-time guard can be exercised end-to-end without waiting on the separate,
// reviewed ADR-flip PR.
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
