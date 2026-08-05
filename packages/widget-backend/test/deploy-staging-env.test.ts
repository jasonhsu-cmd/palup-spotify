import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// D3 — THE DEPLOY ENV LIST, GUARDED. `deploy-staging.yml` warns about the trap in its own comment:
//
//   "--set-secrets / --set-env-vars REPLACE the whole set on every deploy — any secret/env the service
//    needs MUST be listed here or it is silently dropped on the next merge-deploy."
//
// That is not a hypothetical. Track B shipped C1's install env vars, B2's per-tenant credential key, C2's
// webhook gate and D2's per-tenant region, documented every one of them in docs/DEPLOY.md, and passed NONE
// of them to the service — so the code reading them was unreachable in staging. This file is the machine
// check that stops the list regressing: it does NOT prove a deploy works (only an actual deploy does
// that), it proves the list has not silently lost an entry.
//
// WHAT IT CANNOT CATCH, stated so nobody reads more into a green run than is there: it cannot tell you
// that a Secret Manager secret exists, that a repo variable is set, or that gcloud accepts the resulting
// command. Those are only knowable from a real deploy, which CI must never perform.
//
// WHY A TEXT ASSERTION AND NOT A YAML PARSE: this repo has no YAML dependency (checked package.json and
// every packages/*/package.json), and adding one to assert on a 115-line file would be a worse trade than
// substring matching. The failure this must catch is DELETION, which substring matching catches exactly.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

const WORKFLOW = fileURLToPath(new URL("../../../.github/workflows/deploy-staging.yml", import.meta.url));
const yml = readFileSync(WORKFLOW, "utf8");

/**
 * Every env var the deployed widget backend needs in staging, with the code that reads it. A name here
 * that is missing from the workflow means the service boots without it and the feature is silently absent.
 */
const REQUIRED_ENV: Array<[name: string, why: string]> = [
  ["GOOGLE_CLOUD_PROJECT", "the live Vertex adapter; without it /health reports model=mock (model-vertex)"],
  ["GOOGLE_CLOUD_LOCATION", "the Vertex region (model-vertex)"],
  ["PALUP_MODEL", "the pinned model id"],
  ["PALUP_REQUIRE_DATABASE_URL", "the 'this is a real deployment' marker — fails boot without DATABASE_URL"],
  ["WIDGET_AUTH_REQUIRED", "the app-level tenancy gate (server.ts)"],
  ["WIDGET_EMBED_KEYS", "the publishable-key registry; REQUIRED, refuses to boot without it (resolveEmbedKeys)"],
  ["SHOPIFY_STORES", "the tenant -> shop-domain map for grounding (merchant-store.ts)"],
  // D2 — the two that decide the CONSENT REGIME and the grounding posture for every tenant the merchant
  // registry has no row for. Unset, MERCHANT_REGION silently defaults to "us" (server.ts), which is a
  // residency decision made by an absent env var — exactly what the legal review flagged.
  ["MERCHANT_REGION", "D2 — the named region fallback for a tenant with no pl_merchant row"],
  ["MERCHANT_GROUNDING_MODE", "D2 — the same fallback for groundingMode"],
  // C1 — the Shopify app install. All three are individually load-bearing: server.ts refuses to register
  // the routes at all unless every one is present (fully-configured-or-absent), so a partial set is a
  // silent 404 rather than a half-working install.
  ["SHOPIFY_APP_CLIENT_ID", "C1 — the app's OAuth client id (not a secret; it ships in the URL)"],
  ["SHOPIFY_INSTALL_REDIRECT_URI", "C1 — must also be an allowed redirect URL on the Shopify app"],
  ["SHOPIFY_INSTALL_REGION", "C1 — required with NO default; NewMerchant.region may not be guessed"],
];

/** Cloud Run secret mounts. Each must resolve to a Secret Manager secret that already exists — a
 *  reference to a missing secret makes `gcloud run deploy` itself fail, which breaks every merge. */
const REQUIRED_SECRETS: Array<[name: string, secret: string]> = [
  ["DATABASE_URL", "palup-staging-database-url"],
  ["WIDGET_TOKEN_SECRET", "widget-token-secret"],
  // Holds the per-tenant Storefront token AND, since Track B, `shopify_app_client_secret` under the
  // `__shopify_app__` scope (C1/C2's gate) and `MEMORY_ENCRYPTION_KEY__merchant-cred` per installing
  // tenant (B2). Those are JSON entries INSIDE this one secret — they need no new mount, which is why
  // there is nothing to add here for them.
  ["PALUP_SECRETS", "palup-secrets"],
];

describe("D3 — deploy-staging.yml carries every env var and secret the service actually needs", () => {
  it.each(REQUIRED_ENV)("passes %s (%s)", (name) => {
    expect(yml).toContain(`${name}=`);
  });

  it.each(REQUIRED_SECRETS)("mounts %s from the Secret Manager secret %s", (name, secret) => {
    expect(yml).toContain(`${name}=${secret}:latest`);
  });

  it("references secrets ONLY by Secret Manager name — no secret value is ever inlined", () => {
    // Every --set-secrets entry must be `ENV=<secret>:latest`. A literal would put a credential in git.
    const mounts = yml.match(/[A-Z_]+=[a-z0-9-]+:latest/g) ?? [];
    expect(mounts.length).toBeGreaterThanOrEqual(REQUIRED_SECRETS.length);
    for (const m of mounts) expect(m).toMatch(/^[A-Z_]+=[a-z0-9-]+:latest$/);
  });
});

describe("D3 — the optional pieces are opt-in, so a deploy can never reference a secret nobody created", () => {
  it("AUDIT_HMAC_SECRET is mounted only when an operator NAMES an existing secret", () => {
    // It is optional in code (server.ts falls back to SHOPPER_TOKEN_SECRET, and `subjectRef` degrades to
    // "unreferenced (no AUDIT_HMAC_SECRET configured)" rather than throwing — routes/shopify-webhooks.ts).
    // Hard-coding a `--set-secrets AUDIT_HMAC_SECRET=…:latest` line would make EVERY merge-deploy fail
    // until someone created that secret, so it is gated on a repo variable that holds the secret's name.
    expect(yml).toContain("AUDIT_HMAC_SECRET_NAME");
    expect(yml).toMatch(/AUDIT_HMAC_SECRET=\$\{?AUDIT_HMAC_SECRET_NAME/);
  });

  it("the C1 install trio is ALL-OR-NOTHING — a partial set fails the deploy loudly instead of 404ing", () => {
    // server.ts's gate is `Boolean(clientId && redirectUri && region && secret && …)`, so a half-set of
    // repo variables produces routes that are simply absent. That is the right runtime posture and the
    // wrong deploy posture: the operator who set two of three needs to be told.
    expect(yml).toMatch(/::error::.*[Ss]hopify install/);
  });

  it("no env pair is ever emitted with an empty value", () => {
    // `--set-env-vars A=@B=x` (an empty value from an unset repo variable) is not a shape this workflow
    // may produce: it is unverified whether gcloud accepts it, and finding out on a live merge-deploy is
    // not an acceptable way to find out. Optional values are therefore appended conditionally.
    expect(yml).not.toMatch(/@[A-Z_]+=@/);
    expect(yml).not.toMatch(/@[A-Z_]+="/);
  });
});

describe("D3 — the safety properties of this workflow are unchanged", () => {
  it("still deploys only after ci CONCLUDED SUCCESSFULLY (never as a sibling of it)", () => {
    expect(yml).toMatch(/workflow_run:\s*\n\s*workflows: \[ci\]/);
    expect(yml).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(yml).toContain("vars.STAGING_ENABLED == 'true'");
  });

  it("still pins the exact commit ci validated, not the branch tip", () => {
    expect(yml).toContain("ref: ${{ github.event.workflow_run.head_sha }}");
  });

  it("still serializes deploys through the deploy-staging concurrency group", () => {
    expect(yml).toMatch(/concurrency:\s*\n\s*group: deploy-staging\s*\n\s*cancel-in-progress: false/);
  });

  it("still runs the post-deploy smoke gate: health + auth enforced + a live /chat", () => {
    expect(yml).toContain("Post-deploy smoke gate");
    expect(yml).toContain("/health");
    expect(yml).toContain("expected 401");
    expect(yml).toContain("/widget/token?key=demo-embed-key");
    // D1's resolver mode, asserted so a dropped DATABASE_URL cannot leave staging resolving from env only.
    expect(yml).toContain(".merchants");
  });

  it("never deploys production and never runs a deploy from CI itself", () => {
    expect(yml).toContain("palup-widget-staging");
    expect(yml).not.toMatch(/palup-widget-prod|--project .*prod/);
  });
});
