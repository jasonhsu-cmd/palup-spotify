import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ModelPort } from "@palup/platform-ports";
import { MockCommerceAdapter, StaticGroundingAdapter, createBrain } from "../src/index.js";
import type { CatalogRetrieverPort, Signals } from "../src/types.js";
import { FLAG_OFF_PROBES, captureFlagOff, type Probe, type ProbeCapture } from "./helpers/flag-off-probes.js";

// E3 + E4's BRAIN-SIDE MERGE BAR, on E1's harness and E1's golden — deliberately NOT a new one, for the
// same reason E2 reused it: `fixtures/flag-off-golden.json` was captured on the commit BEFORE E1's
// implementation existed, through a RECORDING ModelPort, so the SYSTEM PROMPT itself is inside the
// assertion. Re-running it here proves something stronger than "E3/E4 changed nothing since E2": it
// proves the prompt, every `Decision` and every reply are still byte-identical to the tree before ANY of
// the four flags in this wave existed.
//
// The WIRE half of the same claim — the serialized /chat body and the telemetry rows, which a brain-level
// golden structurally cannot see because `createBrain` is not `POST /chat` — lives in
// `packages/widget-backend/test/chat-wire-flag-off.test.ts` against its own pre-implementation golden.
//
// ⚠️ Neither golden may be regenerated to make a failing test pass — see the warnings in
// helpers/flag-off-probes.ts and widget-backend/test/helpers/chat-wire-probes.ts.
const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(here, "fixtures", "flag-off-golden.json"), "utf8")) as ProbeCapture[];

function explodingRetriever(): CatalogRetrieverPort {
  return {
    async retrieve() {
      throw new Error("retriever was consulted while CATALOG_RETRIEVAL is OFF");
    },
  };
}

/** Line items on EVERY probe, including ids the demo catalog really has and ids it does not. */
const withCartItems = (s: Signals): Signals => ({
  ...s,
  cartItems: [
    { productId: "serum-vc", quantity: 2 },
    { productId: "not-a-real-product", quantity: 9 },
  ],
});

describe("E3 + E4 — flags OFF are byte-identical to the commit before E1, E2, E3 and E4 existed", () => {
  it("the golden still covers every rung of the ladder and every prompt-shaping branch", () => {
    expect(golden.map((g) => g.id)).toEqual(FLAG_OFF_PROBES.map((p) => p.id));
    expect(golden.filter((g) => g.requests.length > 0).length).toBeGreaterThan(15);
  });

  it("today's call site (nothing extra passed) still reproduces the golden decision AND prompt, byte for byte", async () => {
    expect(await captureFlagOff()).toEqual(golden);
  });

  it("the two new flags left at their defaults change nothing", async () => {
    const build = (model: ModelPort, probe: Probe) =>
      createBrain(
        model,
        new StaticGroundingAdapter(),
        undefined,
        probe.noCommerce ? undefined : new MockCommerceAdapter(),
        undefined,
        probe.recalled ? { async recall() { return probe.recalled!; } } : undefined,
        false, false, false, false,
        explodingRetriever(),
        false,
        undefined,
        false, // productCitationsEnabled
        // productCardsEnabled and cartLineItemsEnabled are DELIBERATELY not passed — the defaults must be off.
      );
    expect(await captureFlagOff(build)).toEqual(golden);
  });

  it("passing PRODUCT_CARDS and CART_LINE_ITEMS explicitly false is the same thing", async () => {
    const build = (model: ModelPort, probe: Probe) =>
      createBrain(
        model,
        new StaticGroundingAdapter(),
        undefined,
        probe.noCommerce ? undefined : new MockCommerceAdapter(),
        undefined,
        probe.recalled ? { async recall() { return probe.recalled!; } } : undefined,
        false, false, false, false,
        explodingRetriever(),
        false,
        undefined,
        false, // productCitationsEnabled
        false, // productCardsEnabled
        false, // cartLineItemsEnabled
      );
    expect(await captureFlagOff(build)).toEqual(golden);
  });

  // The strong form of "off": the SIGNAL IS PRESENT on every probe and still nothing moves. An absent
  // signal changing nothing would prove much less than an ignored one.
  it("a fully-populated signals.cartItems on EVERY probe still reproduces the golden, with the flag off", async () => {
    const build = (model: ModelPort, probe: Probe) =>
      createBrain(
        model,
        new StaticGroundingAdapter(),
        undefined,
        probe.noCommerce ? undefined : new MockCommerceAdapter(),
        undefined,
        probe.recalled ? { async recall() { return probe.recalled!; } } : undefined,
        false, false, false, false,
        explodingRetriever(),
        false,
        undefined,
        false, false, false,
      );
    expect(await captureFlagOff(build, withCartItems)).toEqual(golden);
  });

  it("PRODUCT_CARDS ON with PRODUCT_CITATIONS off is ALSO byte-identical — cards have no independent source", async () => {
    // Cards are assembled from what the citation map resolved. With citations off nothing resolves, so
    // turning cards on alone must be inert rather than reaching for a second, unaudited source of ids.
    const build = (model: ModelPort, probe: Probe) =>
      createBrain(
        model,
        new StaticGroundingAdapter(),
        undefined,
        probe.noCommerce ? undefined : new MockCommerceAdapter(),
        undefined,
        probe.recalled ? { async recall() { return probe.recalled!; } } : undefined,
        false, false, false, false,
        explodingRetriever(),
        false,
        undefined,
        false, // productCitationsEnabled OFF
        true, // productCardsEnabled ON
        false,
      );
    expect(await captureFlagOff(build)).toEqual(golden);
  });

  it("CART_LINE_ITEMS ON never touches a guardrail rung, even with line items supplied", async () => {
    // The flag ON is a behaviour change on the SALES path by design — that is what needs a promotion.
    // What must hold even then: no guardrail rung's prompt gains a cart block, because none of them
    // reaches the clean-sales-path call site that passes one.
    const build = (model: ModelPort, probe: Probe) =>
      createBrain(
        model,
        new StaticGroundingAdapter(),
        undefined,
        probe.noCommerce ? undefined : new MockCommerceAdapter(),
        undefined,
        probe.recalled ? { async recall() { return probe.recalled!; } } : undefined,
        false, false, false, false,
        undefined,
        false,
        undefined,
        false, false,
        true, // cartLineItemsEnabled ON
      );
    const captured = await captureFlagOff(build, withCartItems);
    for (const cap of captured) {
      if (cap.id.startsWith("sales-")) continue; // the sales path is where E4 deliberately acts
      for (const req of cap.requests) {
        const sys = req.messages.find((m) => m.role === "system")?.content ?? "";
        expect(sys, `${cap.id} rendered a SHOPPER CART block off the sales path`).not.toContain("=== SHOPPER CART");
      }
    }
  });
});
