import { useCallback } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";

// The console's ONLY point of contact with Shopify App Bridge (F2's client-side counterpart).
// Every other module (api.ts, every screen) takes a plain `getToken: () => Promise<string>` —
// injected here in the app, injected as a fake in every test — so nothing else needs to know App
// Bridge exists.
//
// PRIMARY SOURCE (retrieved 2026-08-24, this session): shopify.dev "App Home" doc
// (https://shopify.dev/docs/api/app-home), section "Retrieve session token to authenticate with
// your backend": `const token = await shopify.idToken();` sent as `Authorization: Bearer <token>`.
// `shopify` is the global the App Bridge CDN script (`index.html`'s
// `<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js">`) installs on `window`;
// `useAppBridge()` (`@shopify/app-bridge-react`, confirmed v4.2.12 on npm) returns that global, and
// throws synchronously if the script tag never ran (i.e. this app isn't actually embedded) — that
// is the CORRECT fail-loud behavior for a console that only ever runs inside Shopify admin.
// `ShopifyGlobal.idToken` is typed `() => Promise<string>` in `@shopify/app-bridge-types@0.7.2`.
//
// NOTE on the older `@shopify/app-bridge` npm package (v3, `createApp` + `@shopify/app-bridge-utils`'s
// `getSessionToken(app)`): that is Shopify's PREVIOUS client library, not the current one — its
// latest release (checked on npm this session) is a 3.7.11 maintenance tag, superseded by the
// CDN-script + `@shopify/app-bridge-react` model used here. Not yet exercised against a live,
// embedded Shopify admin session (no golden token captured) — same "verify before go-live" caveat
// `packages/identity-shopify/src/session-token.ts` records for the server side of this same flow.

export type GetToken = () => Promise<string>;

export function useSessionToken(): GetToken {
  const shopify = useAppBridge();
  return useCallback(() => shopify.idToken(), [shopify]);
}
