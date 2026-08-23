import { runMerchantIdentityPortContract } from "@palup/platform-ports";
import { createShopifyAppBridgeIdentity } from "../src/identity.js";
import { createInMemoryJtiGuard } from "../src/jti-guard.js";
import type { MerchantPrincipal } from "@palup/platform-ports";
import { CLIENT_ID, secrets, acme, registryWith, sessionToken, exchangeOk } from "./_harness.js";

// Wires the Shopify App Bridge adapter through the ADR-0011 MerchantIdentityPort contract: two distinct
// `establishSession` calls (distinct jtis so the single-use guard doesn't collide) produce a real owner
// principal and a real least-privilege operator principal, then the shared contract asserts the
// plane-invariants against them.
const id = createShopifyAppBridgeIdentity({
  clientId: CLIENT_ID, secrets, registry: registryWith(acme), jtiGuard: createInMemoryJtiGuard(() => 1000),
  fetchFn: exchangeOk(true), nowSec: () => 1000,
});

async function principalFor(jti: string, accountOwner: boolean): Promise<MerchantPrincipal> {
  const adapter = createShopifyAppBridgeIdentity({
    clientId: CLIENT_ID, secrets, registry: registryWith(acme), jtiGuard: createInMemoryJtiGuard(() => 1000),
    fetchFn: exchangeOk(accountOwner), nowSec: () => 1000,
  });
  const r = await adapter.establishSession(sessionToken({ jti }));
  if (!r.ok) throw new Error(`fixture setup failed: ${r.reason}`);
  return r.principal;
}

const [owner, operator] = await Promise.all([
  principalFor("jti-owner", true),
  principalFor("jti-operator", false),
]);

runMerchantIdentityPortContract(id, owner, operator);
