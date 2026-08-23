// Shopify OAuth 2.0 TOKEN EXCHANGE (RFC 8693 profile). PRIMARY SOURCE (retrieved 2026-08-23):
// shopify.dev "Token exchange". POST https://{shop}/admin/oauth/access_token, x-www-form-urlencoded.
// Requests an ONLINE token so the response carries `associated_user` (the role bootstrap, ADR-0011 §4).
// NEVER throws / NEVER returns a partial value — every refusal is `null` (same leak-boundary posture as
// shopify-install-identity.ts:exchangeInstallCode: client_secret + session token + access_token all
// pass through here, and an exception would carry them into an attacker-reachable response). Nothing logs.

const SHOP_HOST = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;
const GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const SUBJECT_TYPE = "urn:ietf:params:oauth:token-type:id_token";
const REQUESTED = {
  online: "urn:shopify:params:oauth:token-type:online-access-token",
  offline: "urn:shopify:params:oauth:token-type:offline-access-token",
} as const;

export interface AssociatedUser { id: string; accountOwner: boolean; collaborator: boolean; email?: string; }
export type TokenExchangeResult = { accessToken: string; scope: string[]; associatedUser?: AssociatedUser };

export async function exchangeSessionToken(
  args: { shopDomain: string; clientId: string; clientSecret: string; sessionToken: string;
          tokenType: "online" | "offline" },
  fetchFn: typeof fetch,
): Promise<TokenExchangeResult | null> {
  try {
    if (!SHOP_HOST.test(args.shopDomain)) return null; // never POST the secret to an unrecognised host
    if (!args.clientId || !args.clientSecret || !args.sessionToken) return null;
    const body = new URLSearchParams({
      client_id: args.clientId, client_secret: args.clientSecret, grant_type: GRANT,
      subject_token: args.sessionToken, subject_token_type: SUBJECT_TYPE,
      requested_token_type: REQUESTED[args.tokenType],
    });
    const res = await fetchFn(`https://${args.shopDomain}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      access_token?: unknown; scope?: unknown;
      associated_user?: { id?: unknown; account_owner?: unknown; collaborator?: unknown; email?: unknown } | null;
    } | null;
    const accessToken = typeof json?.access_token === "string" ? json.access_token : "";
    if (!accessToken) return null;
    const scope = typeof json?.scope === "string" ? json.scope.split(",").map((s) => s.trim()).filter(Boolean) : [];
    let associatedUser: AssociatedUser | undefined;
    const au = json?.associated_user;
    if (au && (typeof au.id === "string" || typeof au.id === "number")) {
      associatedUser = {
        id: String(au.id), accountOwner: au.account_owner === true, collaborator: au.collaborator === true,
        email: typeof au.email === "string" ? au.email : undefined,
      };
    }
    return { accessToken, scope, associatedUser };
  } catch {
    return null; // a transport fault is a refusal, never an exception carrying the secret upward
  }
}
