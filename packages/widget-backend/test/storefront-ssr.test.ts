import { describe, it, expect } from "vitest";
import { injectStorefrontFirstPage } from "../src/storefront-ssr.js";

const HTML = `<title>{brand} — x</title><span data-brand>Auria</span><p data-policy-shipping>old</p><p data-policy-returns>old</p><!--PALUP_SSR-->`;

describe("injectStorefrontFirstPage", () => {
  it("fills brand, policy, and an escaped JSON script", () => {
    const out = injectStorefrontFirstPage(HTML, {
      brandName: "Acme",
      policy: { shipping: "free ship", returns: "30 days" },
      products: [{ id: "p1", title: "T</script>", price: "$1.00", description: "" }],
      nextCursor: "c2",
    });
    expect(out).toContain("<title>Acme — x</title>");
    expect(out).toContain(">Acme<");
    expect(out).toContain("free ship");
    expect(out).toContain('id="palup-ssr"');
    expect(out).not.toContain("Auria");
    expect(out).not.toContain("{brand}");
    expect(out).not.toContain("</script>T"); // the product title's </script> is escaped, doesn't break out
    expect(out).toContain("\\u003c"); // < escaped
  });

  it("HTML-escapes brand + policy text against injection", () => {
    const out = injectStorefrontFirstPage(HTML, {
      brandName: `A&B <script>alert(1)</script> "quoted"`,
      policy: { shipping: `Ship & <b>fast</b>`, returns: `Return "policy" & <i>terms</i>` },
      products: [],
    });
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).toContain("&amp;");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("&quot;quoted&quot;");
  });

  it("splits a policy string on blank lines into multiple escaped <p> elements", () => {
    const out = injectStorefrontFirstPage(HTML, {
      brandName: "Acme",
      policy: {
        shipping: "First paragraph.\n\nSecond paragraph with <tag> & stuff.",
        returns: "30 days, no questions asked.",
      },
      products: [],
    });
    // shipping had a blank-line split -> two <p data-policy-shipping> paragraphs
    const shippingMatches = out.match(/<p data-policy-shipping>[^]*?<\/p>/g) ?? [];
    expect(shippingMatches.length).toBe(2);
    expect(shippingMatches[0]).toContain("First paragraph.");
    expect(shippingMatches[1]).toContain("Second paragraph with &lt;tag&gt; &amp; stuff.");

    // returns had no blank line -> stays a single <p data-policy-returns> (byte-compatible with brief examples)
    const returnsMatches = out.match(/<p data-policy-returns>[^]*?<\/p>/g) ?? [];
    expect(returnsMatches.length).toBe(1);
    expect(returnsMatches[0]).toBe("<p data-policy-returns>30 days, no questions asked.</p>");
  });

  it("does not reinterpret $-patterns from merchant text as regex replacement tokens", () => {
    // A brand of "$&" would, under a plain-string .replace, re-insert the whole match (defeating
    // escaping); "$$" in a product description would collapse to "$" under a plain-string .replace.
    // A correct implementation uses a replacer FUNCTION everywhere, so these pass through literally.
    const out = injectStorefrontFirstPage(HTML, {
      brandName: "$&",
      policy: { shipping: "free ship", returns: "30 days" },
      products: [{ id: "p1", title: "Save $$$ now", price: "$1.00", description: "Buy $$ get $$ free" }],
    });
    expect(out).toContain("<title>$&amp; — x</title>");
    expect(out).toContain(">$&amp;<");
    expect(out).not.toContain("{brand}amp;");

    const scriptMatch = out.match(/<script id="palup-ssr" type="application\/json">([^]*?)<\/script>/);
    expect(scriptMatch).not.toBeNull();
    const parsed = JSON.parse(scriptMatch![1]);
    expect(parsed.products[0].title).toBe("Save $$$ now");
    expect(parsed.products[0].description).toBe("Buy $$ get $$ free");
  });

  it("keeps a single <p> when the policy has no blank-line paragraph break", () => {
    const out = injectStorefrontFirstPage(HTML, {
      brandName: "Acme",
      policy: { shipping: "free ship", returns: "30 days" },
      products: [],
    });
    expect(out).toContain("<p data-policy-shipping>free ship</p>");
    expect(out).toContain("<p data-policy-returns>30 days</p>");
  });
});
