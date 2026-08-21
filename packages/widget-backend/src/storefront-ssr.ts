import type { StorefrontCatalogWire } from "./routes/storefront-catalog.js";

// Pure SSR-first-page injector for the sample storefront `home.html`. Given the already-published
// wire shape the /storefront/catalog route produces (`StorefrontCatalogWire` — brand/policy/products,
// the SAME neutral, non-secret data a shopper already sees), it fills in the static HTML template so
// the FIRST paint has real content instead of an empty grid, and stashes the same data as JSON for the
// client to hydrate from (no second network round-trip).
//
// §3 / XSS posture:
//  - Brand + policy text are substituted as literal HTML, so they are HTML-escaped here (`&<>"`) before
//    being spliced in — never innerHTML on the client, and never unescaped on the server.
//  - The hydration payload is embedded as `<script type="application/json">…</script>`, read via
//    `JSON.parse` on the client (never innerHTML/eval) — so it is inert w.r.t. HTML parsing. The one
//    remaining escape needed for a JSON island is `<` → `<`, which prevents a `</script>` inside
//    merchant-authored text (e.g. a product title) from prematurely closing the script tag and breaking
//    into the surrounding HTML.
//  - Pure function: no I/O, no globals — safe to unit test byte-for-byte.

const ESCAPE_MAP: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ESCAPE_MAP[c]!);

/** Render one policy string as one or more `<p>` elements, split on blank lines (`\n\n`) so a
 *  multi-paragraph merchant policy renders as real paragraphs instead of one run-on block. A policy
 *  with no blank line stays a single `<p>` — byte-compatible with the single-paragraph case. Each
 *  paragraph is HTML-escaped independently (never innerHTML). NOTE: when a policy has >=2 paragraphs
 *  this emits multiple `<p>` elements sharing the SAME `[attr]` — a consumer must use
 *  `querySelectorAll`, not `querySelector`, to read all of them. */
function renderPolicyParagraphs(attr: string, text: string): string {
  const paragraphs = (text || "")
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const parts = paragraphs.length > 0 ? paragraphs : [""];
  return parts.map((p) => `<p ${attr}>${esc(p)}</p>`).join("");
}

/**
 * Fills the static `home.html` template with the first catalog page's brand, policy, and product
 * data, and injects a `<script id="palup-ssr" type="application/json">` hydration island at the
 * `<!--PALUP_SSR-->` marker. Pure: same inputs -> same output, no side effects.
 */
export function injectStorefrontFirstPage(html: string, data: StorefrontCatalogWire): string {
  const brand = data.brandName || "this store";
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  // Every `.replace` below uses a REPLACER FUNCTION, never a plain replacement string. A plain string
  // is special-cased by JS: `$&`, `` $` ``, `$'`, `$$`, `$n` are reinterpreted inside it, so
  // merchant-controlled text (brand names, policy copy, product titles routinely containing `$`) could
  // silently corrupt the output (e.g. a brand of "$&" would re-insert the whole match, or "$$" in a
  // product description would collapse to a single "$" inside the JSON island). A function return
  // value is always inserted literally, with no `$`-pattern reinterpretation.
  return html
    .replace(/\{brand\}/g, () => esc(brand))
    .replace(/<span data-brand>[^<]*<\/span>/g, () => `<span data-brand>${esc(brand)}</span>`)
    .replace(/<p data-policy-shipping>[^<]*<\/p>/, () => renderPolicyParagraphs("data-policy-shipping", data.policy.shipping))
    .replace(/<p data-policy-returns>[^<]*<\/p>/, () => renderPolicyParagraphs("data-policy-returns", data.policy.returns))
    .replace("<!--PALUP_SSR-->", () => `<script id="palup-ssr" type="application/json">${json}</script>`);
}
