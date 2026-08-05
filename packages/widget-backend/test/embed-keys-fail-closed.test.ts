import { describe, it, expect, afterEach } from "vitest";
import { InMemoryRuntimeStore, createInMemoryVectorStore } from "@palup/platform-ports";
import { buildServer, resolveEmbedKeys } from "../src/server.js";

// P3 (1) — the publishable embed-key registry (WIDGET_EMBED_KEYS) must FAIL CLOSED, not fall back onto
// the demo tenant.
//
// The defect: `parseEmbedKeys` logged a console.warn and then installed `{"demo-embed-key":"demo"}`
// whenever the configured registry did not parse or produced no usable entries. In a real deployment that
// is a silent tenant substitution, and the downstream blast radius is the whole request path — every
// widget then either 401s at /widget/token (its own key is not in the substituted registry) and, with
// WIDGET_AUTH_REQUIRED off, falls back to RUNTIME_TENANT="demo" on /chat, /consent and /forget, so
// sessions, rate-limit buckets, the immutable audit log, telemetry, the traffic/canary log, consent
// records, the memory namespace AND the Shopify grounding context all resolve under tenant `demo`
// (server.ts derives every one of them from that tenantId). That is the cross-tenant isolation invariant
// (docs/design/security-data-path.md §2 / Inv 1; docs/design/shopper-widget.md §"tenant isolation").
// A console.warn is not a gate.
//
// The fix mirrors the two precedents in this repo rather than inventing a mechanism:
//   * `assertMemoryAuthCoupling` (server.ts) — refuse to BOOT rather than serve a dangerous config,
//     exported taking plain values so a test can exercise it without touching real env.
//   * `createRuntimeStore` / PALUP_REQUIRE_DATABASE_URL (state-postgres/factory.ts) — fail fast rather
//     than silently degrading; that same env var is the EXISTING "this is a real deployment" signal
//     (it is set by the prod/staging deploy — see .github/workflows/deploy-staging.yml), so no new env
//     var is invented here.
// Local/dev/demo stays convenient: with WIDGET_EMBED_KEYS unset and no real-deployment marker, the
// built-in demo default is unchanged (widget-tenant.test.ts depends on exactly that).

const ENV_KEYS = ["WIDGET_EMBED_KEYS", "WIDGET_TOKEN_SECRET", "WIDGET_AUTH_REQUIRED", "PALUP_REQUIRE_DATABASE_URL"];
afterEach(() => ENV_KEYS.forEach((k) => delete process.env[k]));

const DEMO_DEFAULT = { "demo-embed-key": "demo" };

describe("resolveEmbedKeys — pure config guard (plain inputs, like assertMemoryAuthCoupling)", () => {
  it("keeps the demo default when nothing is configured and this is NOT a real deployment (local/dev unchanged)", () => {
    expect({ ...resolveEmbedKeys(undefined, false) }).toEqual(DEMO_DEFAULT);
    expect({ ...resolveEmbedKeys("", false) }).toEqual(DEMO_DEFAULT);
  });

  it("REFUSES the demo default in a real deployment with no registry configured", () => {
    expect(() => resolveEmbedKeys(undefined, true)).toThrow(/WIDGET_EMBED_KEYS/);
    expect(() => resolveEmbedKeys("", true)).toThrow(/WIDGET_EMBED_KEYS/);
  });

  it("THE DEFECT: malformed JSON never falls back to the demo tenant — it throws, in either posture", () => {
    const typo = '{"pk_a":"tenant-a"'; // a real-world truncated/typo'd value
    expect(() => resolveEmbedKeys(typo, false)).toThrow(/WIDGET_EMBED_KEYS/);
    expect(() => resolveEmbedKeys(typo, true)).toThrow(/WIDGET_EMBED_KEYS/);
  });

  it("rejects a parsed value that is not a JSON object (no fallback for null/array/string/number)", () => {
    for (const raw of ["null", "[]", '["pk_a"]', '"pk_a"', "42", "true"]) {
      expect(() => resolveEmbedKeys(raw, false), `raw=${raw}`).toThrow(/WIDGET_EMBED_KEYS/);
    }
  });

  it("rejects an EMPTY declared registry — {} used to become the demo tenant silently", () => {
    expect(() => resolveEmbedKeys("{}", false)).toThrow(/WIDGET_EMBED_KEYS/);
  });

  it("rejects an invalid entry value instead of silently dropping it (empty string / non-string)", () => {
    expect(() => resolveEmbedKeys('{"pk_a":""}', false)).toThrow(/WIDGET_EMBED_KEYS/);
    expect(() => resolveEmbedKeys('{"pk_a":123}', false)).toThrow(/WIDGET_EMBED_KEYS/);
    expect(() => resolveEmbedKeys('{"pk_a":null}', false)).toThrow(/WIDGET_EMBED_KEYS/);
    expect(() => resolveEmbedKeys('{"pk_a":{"tenant":"a"}}', false)).toThrow(/WIDGET_EMBED_KEYS/);
  });

  it("rejects the WHOLE registry when only SOME entries are invalid — a dropped merchant is a silent tenant collapse", () => {
    // The old parser kept pk_a, silently dropped pk_b, and never even warned (the map was non-empty),
    // so merchant B's widget 401'd at mint and then served under the RUNTIME_TENANT fallback.
    expect(() => resolveEmbedKeys('{"pk_a":"tenant-a","pk_b":""}', false)).toThrow(/WIDGET_EMBED_KEYS/);
  });

  it("rejects a blank embed KEY (an unusable registry entry, not a tenant named by an empty key)", () => {
    expect(() => resolveEmbedKeys('{"":"tenant-a"}', false)).toThrow(/WIDGET_EMBED_KEYS/);
  });

  it("accepts a valid registry EXACTLY as declared — the demo key is never silently appended", () => {
    const map = resolveEmbedKeys('{"pk_a":"tenant-a","pk_b":"tenant-b"}', true);
    expect({ ...map }).toEqual({ pk_a: "tenant-a", pk_b: "tenant-b" });
    expect(Object.hasOwn(map, "demo-embed-key")).toBe(false);
  });

  it("keeps the null prototype (no __proto__/constructor key inheritance) — unchanged property", () => {
    const map = resolveEmbedKeys('{"pk_a":"tenant-a"}', false);
    expect(Object.getPrototypeOf(map)).toBeNull();
    expect(map["constructor" as keyof typeof map]).toBeUndefined();
  });

  it("does not throw on a valid registry regardless of posture (the guard only rejects unusable config)", () => {
    expect(() => resolveEmbedKeys('{"pk_a":"tenant-a"}', false)).not.toThrow();
    expect(() => resolveEmbedKeys('{"pk_a":"tenant-a"}', true)).not.toThrow();
  });
});

describe("buildServer wires the guard — a dangerous registry refuses to BOOT (never serves)", () => {
  const injected = () => ({ store: new InMemoryRuntimeStore(), vectorPort: createInMemoryVectorStore() });

  it("rejects on malformed WIDGET_EMBED_KEYS", async () => {
    process.env.WIDGET_EMBED_KEYS = '{"pk_a":"tenant-a"';
    await expect(buildServer(injected())).rejects.toThrow(/WIDGET_EMBED_KEYS/);
  });

  it("rejects when the real-deployment marker is set but no registry is declared", async () => {
    process.env.PALUP_REQUIRE_DATABASE_URL = "true";
    await expect(buildServer(injected())).rejects.toThrow(/WIDGET_EMBED_KEYS/);
  });

  it("fails fast BEFORE store construction — the embed-key error wins over PALUP_REQUIRE_DATABASE_URL's own", async () => {
    // No injected store and no DATABASE_URL, so createRuntimeStore() would itself throw about
    // PALUP_REQUIRE_DATABASE_URL. The embed-key guard must run first (same placement rationale as
    // assertMemoryAuthCoupling: a rejected boot must leave no pool/DDL work behind).
    process.env.PALUP_REQUIRE_DATABASE_URL = "true";
    process.env.WIDGET_EMBED_KEYS = "{oops";
    await expect(buildServer()).rejects.toThrow(/WIDGET_EMBED_KEYS/);
  });

  it("boots in a real deployment once the registry is declared, and the demo key is NOT accepted there", async () => {
    process.env.PALUP_REQUIRE_DATABASE_URL = "true";
    process.env.WIDGET_EMBED_KEYS = JSON.stringify({ "pk-acme": "acme" });
    process.env.WIDGET_TOKEN_SECRET = "wsecret";
    const app = await buildServer(injected());

    const ok = await app.inject({ method: "GET", url: "/widget/token?key=pk-acme" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().token).toBeTruthy();

    const demo = await app.inject({ method: "GET", url: "/widget/token?key=demo-embed-key" });
    expect(demo.statusCode).toBe(401); // the silent demo fallback is gone

    await app.close();
  });

  it("local/dev is unchanged: nothing configured ⇒ demo-embed-key still mints tenant demo", async () => {
    process.env.WIDGET_TOKEN_SECRET = "wsecret";
    const app = await buildServer(injected());
    const res = await app.inject({ method: "GET", url: "/widget/token?key=demo-embed-key" });
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBeTruthy();
    await app.close();
  });

  it("the refusal is observable and names the variable, and never echoes the configured value", async () => {
    process.env.WIDGET_EMBED_KEYS = '{"pk-super-secret-looking":"tenant-a"';
    const err = await buildServer(injected()).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/WIDGET_EMBED_KEYS/);
    expect(err.message).not.toContain("pk-super-secret-looking"); // no config value in an error/log
  });
});
