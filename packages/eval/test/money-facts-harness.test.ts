import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelPort, ModelRequest, ModelResponse } from "@palup/platform-ports";
import { buildMoneyFactsBrain, gradeMoneyFacts, type MoneyFactsCase } from "../src/money-facts-harness.js";

// go-live §B — the money-facts harness PLUMBING, gate-tested without GCP creds. A scripted model stands in
// for the real one: it reads the CATALOG line the harness built for the target product and replies as a
// well-behaved model would — quoting the shown price, or offering to confirm when the price is withheld.
// So this proves buildMoneyFactsBrain plumbs (seeded facts → the staleness ceiling → the CATALOG block)
// AND gradeMoneyFacts agree end to end. The REAL-model quality run is `pnpm eval:money-facts` (needs creds).

/**
 * Replies like a compliant model: quote the target product's shown price, or offer to confirm when it's
 * withheld — EITHER because the fact is explicitly stale (`priceConfirmed:false`, rendered as the
 * `PRICE_UNCONFIRMED_TEXT` sentinel) OR because the CATALOG line's price field is simply EMPTY.
 *
 * S2 (owner-ruled 2026-08-16): on the CATALOG_RETRIEVAL shell render path there is no live-catalog base
 * price to fall back to — `ProductFactsPort` is the SOLE price source (see `brain.ts`'s `retrieveViaShell`
 * + `hydrateProductFacts`). A product with no fresh fact at all (missing, or a fact seeded under a
 * DIFFERENT tenant) is passed through `hydrateProductFacts` UNCHANGED — `price: ""`, no explicit
 * `priceConfirmed:false` — so its CATALOG line renders with an empty price field, e.g. `Balancing Toner
 * ()`. That is a DIFFERENT rendered shape from the explicit stale sentinel, but the SAME fact for a
 * shopper — "no confirmed price to quote" — and the system prompt's own standing rule ("if a fact isn't
 * there, say you're not certain and will check") tells a real model to respond to it the same way. This
 * scripted stand-in is updated to match, so the grader exercises the ACTUAL S2 rendered shape rather than
 * one this path no longer produces. Priced retrieval serving REQUIRES the A3 ProductFacts producer to have
 * populated a fact for a SKU — an undocumented operational precondition made explicit here.
 */
class ScriptedModel implements ModelPort {
  constructor(private readonly targetTitle: string) {}
  async complete(req: ModelRequest): Promise<ModelResponse> {
    const sys = req.messages.find((m) => m.role === "system")?.content ?? "";
    const line = sys.split("\n").find((l) => l.includes(this.targetTitle)) ?? "";
    const priceField = /\(([^)]*)\)/.exec(line)?.[1] ?? "";
    if (priceField === "" || priceField.includes("needs confirming")) {
      return { text: `I'll confirm the current price for the ${this.targetTitle} before you buy — let me check on that.`, model: "scripted" } as ModelResponse;
    }
    const price = /\$[\d.]+/.exec(priceField)?.[0] ?? "(unknown)";
    return { text: `The ${this.targetTitle} is ${price}.`, model: "scripted" } as ModelResponse;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const { cases } = JSON.parse(readFileSync(join(here, "..", "cases", "money-facts.json"), "utf8")) as { cases: MoneyFactsCase[] };

describe("money-facts harness — facts → hydration → CATALOG → deterministic grade (scripted model)", () => {
  for (const c of cases) {
    it(`${c.id} (${c.kind}) — a compliant reply passes the grader`, async () => {
      const brain = await buildMoneyFactsBrain(c, new ScriptedModel(c.products[0]!.title));
      const d = await brain.decide({ tenantId: c.tenantId } as never, c.message);
      const g = gradeMoneyFacts(c, d.reply);
      expect(g.fails, `${c.id}: ${g.fails.join("; ")} | reply=${d.reply}`).toEqual([]);
      expect(g.pass).toBe(true);
    });
  }

  it("the grader FAILS a stale-quoting reply (a fabricated/stale money fact is caught)", () => {
    const stale = cases.find((c) => c.kind === "stale")!;
    // A model that quotes the stale number instead of confirming must fail withholdsPrice + notQuotes.
    const g = gradeMoneyFacts(stale, `The ${stale.products[0]!.title} is ${stale.facts[0]!.price}.`);
    expect(g.pass).toBe(false);
  });

  it("the grader FAILS a cross-tenant leak", () => {
    const xt = cases.find((c) => c.kind === "cross_tenant")!;
    const g = gradeMoneyFacts(xt, `The ${xt.products[0]!.title} is ${xt.facts[0]!.price}.`); // rival's price
    expect(g.pass).toBe(false);
  });
});
