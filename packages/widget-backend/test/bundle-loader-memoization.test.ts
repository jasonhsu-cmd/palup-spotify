import { describe, it, expect, vi } from "vitest";

// Perf hardening (deferred #287/#288 review minor): `bundleLoader()` (routes/embed.ts) re-runs a full
// esbuild bundle+minify pass EVERY time it's called — and `buildServer()` calls it once per boot, which
// is once per prod process but once per TEST too: 200+ times across this package's own suite alone
// (`grep -rc "buildServer(" test/*.ts` sums to 208 across 46 files at the time this test was written).
// esbuild is mocked here (a spy wrapping the REAL implementation, so the assertion is about CALL COUNT,
// not about faking the bundle away) to prove `bundleLoader()` invokes esbuild's `build()` at most once
// per process, however many times it's called.
//
// `vi.mock` is hoisted to the top of this file by Vitest, so it applies before `../src/routes/embed.js`
// (and transitively `esbuild`) is ever imported below — the same pattern this package's own
// memory-auth-boot-guard.test.ts uses for `@palup/widget-memory`.
const buildSpy = vi.fn();
vi.mock("esbuild", async (importOriginal) => {
  const actual = await importOriginal<typeof import("esbuild")>();
  buildSpy.mockImplementation(actual.build);
  return { ...actual, build: buildSpy };
});

const { bundleLoader } = await import("../src/routes/embed.js");

describe("bundleLoader() memoizes the esbuild bundle at module scope", () => {
  it("a second (and third) call reuses the first build instead of re-invoking esbuild", async () => {
    const first = await bundleLoader();
    const second = await bundleLoader();
    const third = await bundleLoader();

    // Structural proof: esbuild's build() ran exactly once for three calls in this process.
    expect(buildSpy).toHaveBeenCalledTimes(1);

    // Behavioral proof: every call still returns the identical bundled JS.
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(first.length).toBeGreaterThan(0);
  });

  it("concurrent early callers share the one in-flight build (memoized as a promise, not a resolved value)", async () => {
    const [a, b] = await Promise.all([bundleLoader(), bundleLoader()]);
    expect(a).toBe(b);
    // Still just the one call from the previous test — memoization is process-wide (module-scope), so a
    // concurrent pair issued here must NOT add a second esbuild invocation.
    expect(buildSpy).toHaveBeenCalledTimes(1);
  });
});
