import { createEnvSecrets } from "@palup/platform-ports";
import {
  DELEGATE_SCOPES_DEFAULT,
  SHOPIFY_APP_CLIENT_SECRET_NAME,
  SHOPIFY_APP_SECRET_SCOPE,
  createDelegateAccessToken,
  exchangeInstallCode,
} from "./shopify-install-identity.js";
import { storefrontFetch } from "./shopify-grounding.js";

// D2 — the OPERATOR LIVE-VERIFICATION HARNESS for the storefront-token read-back chain: OAuth install
// exchange → delegate mint → Storefront read. That chain has NEVER run against a real Shopify store from
// this repo — every existing test (shopify-install-identity.test.ts, shopify-grounding.test.ts) exercises
// it against an INJECTED fetch. This file is the one command that proves the real wire works, the same
// role packages/model-vertex/src/smoke.ts plays for the model path.
//
// Usage (run once at go-live, and again after any change to the wire-format adapters):
//
//   SHOPIFY_APP_CLIENT_ID=<the app's OAuth client id> \
//   PALUP_SECRETS='{"__shopify_app__":{"shopify_app_client_secret":"<the app's OAuth client secret>"}}' \
//   pnpm shopify:verify <shop>.myshopify.com <code>
//
// (SHOPIFY_APP_CLIENT_ID and the PALUP_SECRETS shape above are the SAME env vars the install routes
// already read in server.ts — see SHOPIFY_APP_SECRET_SCOPE / SHOPIFY_APP_CLIENT_SECRET_NAME in
// shopify-install-identity.ts and docs/DEPLOY.md's env table. No new secret convention.)
//
// How to obtain <code>: build the authorize URL (buildInstallAuthorizeUrl in shopify-install-identity.ts:
// https://{shop}/admin/oauth/authorize?client_id=...&scope=...&redirect_uri=...&state=...), open it in a
// browser against a real dev store, approve the install, and copy the `code` query parameter Shopify
// appends to the redirect it sends your redirect_uri to. The code is SINGLE-USE and SHORT-LIVED — run this
// command IMMEDIATELY after copying it. A stale or already-used code makes exchangeInstallCode refuse
// (this prints `FAIL (exchange)`), not throw.
//
// NEVER prints, logs, or returns a token. Only PASS/FAIL, a product count, and the (non-secret) scope
// arrays reach stdout — see the return type of runShopifyVerify below.

export interface RunShopifyVerifyArgs {
  shopDomain: string;
  code: string;
  clientId: string;
  clientSecret: string;
  delegateScopes?: readonly string[];
}

export type RunShopifyVerifyResult =
  | { ok: true; productCount: number; grantedScopes: string[]; accessScopes: string[] }
  | { ok: false; stage: "exchange" | "delegate" | "storefront"; detail?: string };

/**
 * Chains exchangeInstallCode → createDelegateAccessToken → storefrontFetch, exactly as the install routes
 * (server.ts) and the grounding adapter (shopify-grounding.ts) already call them — this function
 * introduces no new wire-format logic, it only sequences the three existing calls and reports which stage
 * failed. Never throws: every refusal (a `null` from the first two, a thrown storefront fetch) becomes a
 * stage-tagged `{ ok: false }`. The success value carries a COUNT and SCOPE ARRAYS, never the tokens
 * themselves — `grant.accessToken` and `delegate.accessToken` are used only as call arguments and never
 * assigned into the returned object.
 */
export async function runShopifyVerify(args: RunShopifyVerifyArgs, fetchFn: typeof globalThis.fetch): Promise<RunShopifyVerifyResult> {
  const grant = await exchangeInstallCode(
    { shopDomain: args.shopDomain, clientId: args.clientId, clientSecret: args.clientSecret, code: args.code },
    fetchFn,
  );
  if (!grant) return { ok: false, stage: "exchange" };

  const delegate = await createDelegateAccessToken(
    {
      shopDomain: args.shopDomain,
      parentAccessToken: grant.accessToken,
      delegateScopes: args.delegateScopes ?? DELEGATE_SCOPES_DEFAULT,
    },
    fetchFn,
  );
  if (!delegate) return { ok: false, stage: "delegate" };

  try {
    const data = await storefrontFetch(fetchFn)({ shopDomain: args.shopDomain, accessToken: delegate.accessToken });
    return {
      ok: true,
      productCount: data.products?.nodes?.length ?? 0,
      grantedScopes: grant.grantedScopes,
      accessScopes: delegate.accessScopes,
    };
  } catch (e) {
    return { ok: false, stage: "storefront", detail: (e as Error).message };
  }
}

async function main(): Promise<void> {
  const shopDomain = process.argv[2];
  const code = process.argv[3];
  const clientId = process.env.SHOPIFY_APP_CLIENT_ID;
  // Same convention the install routes use (server.ts) — read via SecretsPort, never a raw secret env var.
  const clientSecret = await createEnvSecrets().get(SHOPIFY_APP_SECRET_SCOPE, SHOPIFY_APP_CLIENT_SECRET_NAME);

  const usage =
    "Usage: pnpm shopify:verify <shop>.myshopify.com <code>\n\n" +
    "Requires in the environment:\n" +
    "  SHOPIFY_APP_CLIENT_ID   — the app's OAuth client id\n" +
    `  PALUP_SECRETS           — '{"${SHOPIFY_APP_SECRET_SCOPE}":{"${SHOPIFY_APP_CLIENT_SECRET_NAME}":"<the app's OAuth client secret>"}}'\n\n` +
    "See the top-of-file comment in shopify-verify-smoke.ts for how to obtain <code>.";

  if (!shopDomain || !code || !clientId || !clientSecret) {
    console.error(usage);
    process.exit(2);
    return;
  }

  const result = await runShopifyVerify({ shopDomain, code, clientId, clientSecret }, globalThis.fetch);
  if (result.ok) {
    console.log(`PASS — read ${result.productCount} product(s) via the Storefront API`);
    console.log("granted scopes (install):", result.grantedScopes.join(", ") || "(none)");
    console.log("access scopes (delegate):", result.accessScopes.join(", ") || "(none)");
    process.exit(0);
  } else {
    console.error(`FAIL (${result.stage})${result.detail ? `: ${result.detail}` : ""}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
