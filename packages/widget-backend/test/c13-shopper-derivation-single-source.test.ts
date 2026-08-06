import { describe, it, expect, afterEach } from "vitest";
import { InMemoryRuntimeStore, createInMemoryVectorStore, mintWidgetToken, mintShopperToken } from "@palup/platform-ports";
import { lookupConsent } from "@palup/state-postgres";
import { accountSubjectId } from "@palup/widget-memory";
import { buildServer } from "../src/server.js";
import { guestTokenHeader } from "./helpers/guest-token.js";

// ADR-0019 task 6 — C13 is CLOSED: `/chat` and `/consent`/`/forget` now derive the verified shopper through
// ONE resolver (`resolveVerifiedShopper`), so the security gates (flag, merchant principal, verified,
// cross-shop tenant check) cannot drift between routes.
//
// SCOPE OF THIS FILE (stated precisely, per the task-6 security review): it exercises the shared resolver
// through the `verifiedShopperIdFor` projection that `/consent` (and `/forget`) use, asserting the
// own-tenant-honored vs foreign-tenant-rejected decision. `/chat`'s use of the SAME resolver — the other
// half of C13 — is exercised with an `x-shopper-token` in `consent-restrictive-merge.test.ts` (POST /chat).
// Together they cover both callers of the single source; this file is the `/consent`-side pin.

const WIDGET_SECRET = "wsecret";
const SHOPPER_SECRET = "shopper-secret";
const GUEST_SECRET = "gsecret";
const DEMO_WIDGET_TOKEN = mintWidgetToken(WIDGET_SECRET, "demo", 3_600);
const OWN_SHOPPER = "shopify:demo:100"; // a shopper of THIS tenant
const FOREIGN_SHOPPER = "shopify:other:200"; // minted for a DIFFERENT tenant — must be rejected (F1)
const GUEST = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const ENV = ["WIDGET_TOKEN_SECRET", "WIDGET_AUTH_REQUIRED", "SHOPPER_AUTH", "SHOPPER_TOKEN_SECRET", "GUEST_TOKEN_SECRET"];
afterEach(() => ENV.forEach((k) => delete process.env[k]));
function arm(): void {
  process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
  process.env.WIDGET_AUTH_REQUIRED = "true";
  process.env.SHOPPER_AUTH = "true";
  process.env.SHOPPER_TOKEN_SECRET = SHOPPER_SECRET;
  process.env.GUEST_TOKEN_SECRET = GUEST_SECRET;
}

/** Record consent through /chat (which derives the subject) then read which subject it landed under. */
async function subjectUsedByChat(app: Awaited<ReturnType<typeof buildServer>>, store: InMemoryRuntimeStore, shopperToken: string) {
  // A shopper who is verified writes consent under acct:<id>; a rejected token falls back to the guest
  // token's anonId. We detect which by recording an explicit consent and seeing where it lands.
  await app.inject({
    method: "POST",
    url: "/consent",
    headers: { "x-shopper-token": shopperToken, ...guestTokenHeader(GUEST_SECRET, "demo", GUEST) },
    payload: { memoryOrdinary: "out", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
  });
  const underAccount = (await lookupConsent(store, { tenantId: "demo", anonId: accountSubjectId(OWN_SHOPPER) })).memoryOrdinary;
  const underGuest = (await lookupConsent(store, { tenantId: "demo", anonId: GUEST })).memoryOrdinary;
  return { underAccount, underGuest };
}

describe("C13 closed — /chat and /consent resolve the verified shopper through one source", () => {
  it("an OWN-tenant verified shopper token is honored (consent lands under acct:), on the shared path", async () => {
    arm();
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store, vectorPort: createInMemoryVectorStore(), memoryEnabled: true });
    try {
      const res = await subjectUsedByChat(app, store, mintShopperToken(SHOPPER_SECRET, OWN_SHOPPER, "shopify", 3_600));
      expect(res.underAccount).toBe("out"); // recorded under the account subject
      expect(res.underGuest).toBe("unknown"); // NOT under the guest — the shopper won
    } finally {
      await app.close();
    }
  });

  it("a FOREIGN-tenant shopper token is rejected identically — consent falls to the guest subject, never acct:", async () => {
    arm();
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store, vectorPort: createInMemoryVectorStore(), memoryEnabled: true });
    try {
      const res = await subjectUsedByChat(app, store, mintShopperToken(SHOPPER_SECRET, FOREIGN_SHOPPER, "shopify", 3_600));
      // cross-shop token rejected → no account subject used; the guest token's subject takes it instead.
      expect(res.underGuest).toBe("out");
      expect((await lookupConsent(store, { tenantId: "demo", anonId: accountSubjectId(FOREIGN_SHOPPER) })).memoryOrdinary).toBe("unknown");
    } finally {
      await app.close();
    }
  });
});
