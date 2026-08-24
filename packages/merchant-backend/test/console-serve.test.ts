import { describe, it, expect, beforeAll } from "vitest";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { InMemoryRuntimeStore, type MerchantIdentityPort, type MerchantPrincipal } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";
import { ensureConsoleBuilt } from "./helpers/ensure-console-built.js";

// The merchant-console SPA (a Vite bundle of @palup/merchant-console) is served PUBLIC — no auth
// preHandler — because it's pure app-shell code (no merchant/customer data) and the browser has no
// session token yet when it first loads the embedded iframe. This suite proves that posture is correct
// on BOTH sides: the shell is reachable with no token, and every real DATA route stays gated exactly as
// it was before this work (route-protection.test.ts is the structural guard for the latter; this file
// adds the behavioral proof requested alongside it).
const owner: MerchantPrincipal = { kind: "merchant_user", merchantId: "t1", userId: "u1", role: "owner", authLevel: "session", sessionId: "s1" };
const identity: MerchantIdentityPort = {
  authenticate: async (cred) => (cred === "good" ? owner : { kind: "anonymous" }),
  authorize: () => true,
};

const consoleDistDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "merchant-console", "dist-web");

beforeAll(() => {
  ensureConsoleBuilt();
}, 120_000);

describe("merchant-console SPA is served publicly; the API stays gated", () => {
  it("GET / with no token returns 200 and the SPA's HTML shell", async () => {
    const app = await buildServer({ store: new InMemoryRuntimeStore(), identity });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain('<div id="root">'); // the SPA's mount point, packages/merchant-console/index.html
    expect(res.body).toContain("PalUp"); // <title>PalUp — Approval Center</title>

    await app.close();
  });

  it("GET /index.html with no token returns the same SPA shell", async () => {
    const app = await buildServer({ store: new InMemoryRuntimeStore(), identity });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/index.html" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain('<div id="root">');

    await app.close();
  });

  it("a REAL built asset under /assets/ is served with no token (public, app-shell code only)", async () => {
    const app = await buildServer({ store: new InMemoryRuntimeStore(), identity });
    await app.ready();

    const assetFiles = readdirSync(join(consoleDistDir, "assets"));
    const jsAsset = assetFiles.find((f) => f.endsWith(".js"));
    expect(jsAsset, "vite build should have produced at least one hashed .js asset").toBeDefined();

    const res = await app.inject({ method: "GET", url: `/assets/${jsAsset}` });

    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it("GET /approvals (a real DATA route) with no token still 401s — the SPA exemption does not leak", async () => {
    const app = await buildServer({ store: new InMemoryRuntimeStore(), identity });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/approvals" });

    expect(res.statusCode).toBe(401);

    await app.close();
  });

  it("an unmatched client-side SPA route (e.g. /some/spa/route) falls back to the SPA shell, not a 401 or a bare 404", async () => {
    const app = await buildServer({ store: new InMemoryRuntimeStore(), identity });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/some/spa/route" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain('<div id="root">');

    await app.close();
  });

  it("a non-GET request to an unmatched path still gets a normal JSON 404, not the SPA shell", async () => {
    const app = await buildServer({ store: new InMemoryRuntimeStore(), identity });
    await app.ready();

    const res = await app.inject({ method: "POST", url: "/some/unmatched/path" });

    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).not.toContain("text/html");

    await app.close();
  });
});
