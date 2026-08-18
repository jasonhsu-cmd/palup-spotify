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
  // D2 — ships dark (`|| 'false'`) like WIDGET_AUTH_REQUIRED immediately above; absent here would silently
  // revert an operator's go-live flip on the very next merge-deploy (docs/DEPLOY.md's D2 go-live section).
  ["MERCHANT_CRED_READBACK_ENABLED", "D2 — gates the custodied-credential read-back path (model.ts)"],
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
  // ── Shopper-widget feature-posture flags. Every one is read by server.ts (or the vector factory) and
  // ships dark via `|| 'false'`. Threaded here for the same reason as WIDGET_AUTH_REQUIRED/READBACK: unset,
  // the code reading them is unreachable in staging, and an operator's Cloud Run flip would be reverted by
  // the next merge-deploy (--set-env-vars REPLACES the whole set). Defaulting false means threading them
  // enables NOTHING — it only makes each a one-var flip instead of manual `gcloud run services update`.
  ["PRODUCT_CITATIONS", "reply-shaping: inline source citations in /chat answers (server.ts)"],
  ["PRODUCT_CARDS", "reply-shaping: structured product cards in /chat answers (server.ts)"],
  ["CART_LINE_ITEMS", "reply-shaping: cart line-items in /chat answers (server.ts)"],
  ["PRODUCT_FACTS_HYDRATION", "money/NN#1: hydrate Tier-2 price/availability facts (server.ts); inert until retrieval + a producer populate facts"],
  ["SERVER_GUARD_SIGNALS", "safety routing: catches injection/distress evasions the floor misses (server.ts)"],
  ["OUTGOING_OFFER_CHECK", "money guard, additive over the always-on floor (server.ts)"],
  // SHOPPER_AUTH has a hard coupling: server.ts FAILS TO BOOT if SHOPPER_AUTH=true while WIDGET_AUTH_REQUIRED
  // is not (F4 startup precondition). Threading it does not create that hazard — it is the server's designed
  // fail-fast — but an operator enabling it must set WIDGET_AUTH_REQUIRED=true in the same deploy.
  ["SHOPPER_AUTH", "shopper identity gate (ADR-0017); only honored when WIDGET_AUTH_REQUIRED is also true (server.ts)"],
  ["SUBSCRIPTION_SELFSERVE", "self-serve skip/pause commerce action; degrades to human-routed without SHOPPER_AUTH (ADR-0016 prereq, server.ts)"],
  // CATALOG_WEBHOOKS is ALSO gated by the derived SHOPIFY_WEBHOOKS_ENABLED (app secret + merchant registry
  // present), so this env alone is inert until the install config is complete — safe to default-false thread.
  ["CATALOG_WEBHOOKS", "live catalog-freshness producer; additionally gated by SHOPIFY_WEBHOOKS_ENABLED (server.ts)"],
  // VECTOR_ANN selects S1's pgvector HNSW store (vector-factory.ts). Enabling it REQUIRES a pgvector-enabled
  // DATABASE_URL and an indexed corpus; default-false keeps the in-memory scan path. Serving >5000 SKUs needs it.
  ["VECTOR_ANN", "retrieval backend: selects the pgvector HNSW store over the brute-force scan (vector-factory.ts)"],
  // MEMORY_ENABLED is the OPERATOR half of cross-visit memory's double gate. It is INERT on its own:
  // isMemoryEnabled() = (MEMORY_ENABLED === "true" && MEMORY_ADR_ACCEPTED), and MEMORY_ADR_ACCEPTED is a
  // hardcoded const that only a human flips after the ADR-0015 legal/security sign-offs (widget-memory/flag.ts).
  // Threaded here (default 'false') so that, once that human flip lands, memory is a one-var deploy flip and an
  // operator's Cloud Run setting is not silently reverted by the next merge-deploy. Default-false enables NOTHING.
  ["MEMORY_ENABLED", "operator half of memory's double gate; INERT until the MEMORY_ADR_ACCEPTED const is also true (widget-memory/flag.ts)"],
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

describe("D3 — Customer Account API (ADR-0018) enablement env is opt-in and ships dark", () => {
  it("SHOPPER_TOKEN_SECRET is mounted only when an operator NAMES an existing secret", () => {
    // Half of the CAA_ENABLED gate (server.ts): CAA mints a shopper token signed with SHOPPER_TOKEN_SECRET,
    // so it must be non-empty for the routes to register. It is a SIGNING SECRET, so it is a --set-secrets
    // mount — gated on a repo variable holding the secret's name, the SAME fail-safe as GUEST_TOKEN_SECRET
    // and AUDIT_HMAC_SECRET: naming a Secret Manager secret that does not exist fails `gcloud run deploy`
    // itself, so hard-coding the mount would break every merge until the secret was created.
    expect(yml).toContain("SHOPPER_TOKEN_SECRET_NAME");
    expect(yml).toMatch(/SHOPPER_TOKEN_SECRET=\$\{?SHOPPER_TOKEN_SECRET_NAME/);
  });

  it("CAA_REDIRECT_URI is threaded from a repo variable and appended ONLY when non-empty", () => {
    // The other half of the CAA_ENABLED gate (server.ts). It has NO safe default — it is a URL that must
    // byte-match the redirect registered on the Shopify Customer Account API OAuth client — so it is
    // appended conditionally and is never emitted empty (the empty-pair guard above forbids `@X=@`). Empty
    // repo variable ⇒ absent ⇒ CAA stays 404 (inert), which is the dark default.
    expect(yml).toContain("CAA_REDIRECT_URI");
    expect(yml).toMatch(/if \[ -n "\$\{CAA_REDIRECT_URI:-\}" \]; then ENVS="\$\{ENVS\}@CAA_REDIRECT_URI=\$\{CAA_REDIRECT_URI\}"; fi/);
  });

  it("CAA_SCOPE is an optional override appended only when non-empty (code default otherwise)", () => {
    // Not part of the gate — server.ts defaults it to "openid email customer-account-api:full". Threaded so
    // an operator can retune the OAuth scope to match the Shopify client WITHOUT a code change, and appended
    // conditionally so an unset repo variable falls through to the code default rather than blanking it.
    expect(yml).toMatch(/if \[ -n "\$\{CAA_SCOPE:-\}" \]; then ENVS="\$\{ENVS\}@CAA_SCOPE=\$\{CAA_SCOPE\}"; fi/);
  });
});

describe("#126 — the async memory-write Pub/Sub push env is opt-in and ships dark, mirroring P4", () => {
  it("MEMORY_PUBSUB_AUDIENCE is threaded as its OWN gate (mirrors CATALOG_PUBSUB_AUDIENCE)", () => {
    expect(yml).toContain("MEMORY_PUBSUB_AUDIENCE: ${{ vars.MEMORY_PUBSUB_AUDIENCE }}");
  });

  it("the update-env-vars block is gated on the audience and sets the memory-write trio, mirroring the catalog block", () => {
    // Same fail-closed shell idiom as the CATALOG_PUBSUB_AUDIENCE block: `if [ -n ... ]; then ... fi`, not
    // `|| true` (a merge-gate no-weakening check greps ADDED lines for that, continue-on-error, if: false).
    expect(yml).toMatch(/if \[ -n "\$\{MEMORY_PUBSUB_AUDIENCE:-\}" \]; then/);
    expect(yml).toContain(
      'MEMORY_PUBSUB_TOPIC=memory-write,MEMORY_PUBSUB_PUSH_SERVICE_ACCOUNT=pubsub-memory-push@${GCP_PROJECT}.iam.gserviceaccount.com,MEMORY_PUBSUB_PUSH_AUDIENCE=${MEMORY_PUBSUB_AUDIENCE}',
    );
  });

  it("absent MEMORY_PUBSUB_AUDIENCE is a documented no-op, not a silent one", () => {
    expect(yml).toMatch(/MEMORY_PUBSUB_AUDIENCE not set.*inert/);
  });

  it("no `|| true`, `continue-on-error`, or `if: false` was introduced by the memory push-env block", () => {
    // Scoped NARROWLY to the actual added run-script block (not the whole file, and not the env: comment
    // above it) — pre-existing shell idiom elsewhere in this workflow legitimately uses `|| true` for
    // `&&`-chained non-assertions (e.g. the C1 install-env-count loop), so this must only catch a NEW
    // occurrence inside the lines this task adds, anchored on a string unique to this block's own comment.
    const start = yml.indexOf("a SECOND --update-env-vars");
    expect(start).toBeGreaterThan(-1);
    const end = yml.indexOf("Post-deploy smoke gate");
    expect(end).toBeGreaterThan(start);
    const block = yml.slice(start, end);
    expect(block).not.toMatch(/\|\|\s*true/);
    expect(block).not.toMatch(/continue-on-error/);
    expect(block).not.toMatch(/if:\s*false/);
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
