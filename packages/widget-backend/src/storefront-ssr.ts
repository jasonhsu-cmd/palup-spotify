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
 *  `querySelectorAll`, not `querySelector`, to read all of them.
 *
 *  LATENT (spec A2c) as of this writing: the `\n\n` split above never actually fires on real data.
 *  `toPlainText` in `routes/storefront-catalog.ts` collapses ALL whitespace — including blank-line
 *  paragraph breaks — to a single space (`.replace(/\s+/g, " ")`) before the wire shape this function
 *  consumes is built, so `data.policy.{shipping,returns}` always arrives as one flattened paragraph by
 *  the time it reaches here. This unit only exercises the split via hand-crafted test input that
 *  bypasses `toPlainText`, not the real pipeline. Shipping true end-to-end multi-paragraph rendering is
 *  a tracked follow-up needing BOTH (a) `toPlainText` to preserve paragraph boundaries instead of
 *  collapsing them, and (b) `app.js`'s `setPolicy` to `querySelectorAll` + replace every `[data-policy-*]`
 *  `<p>` it's handed (it currently `querySelector`s and can only ever address the first). Not
 *  implemented here — this is a comment-only note, no behavior change. */
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

// A `<script src="…" defer>` for the home page's hydration script leaves a real network-fetch + task-
// boundary gap between the HTML parser finishing and the script actually running — during which Chromium
// can (and, measured live via the storefront-catalog E2E CLS assertion, reliably does) paint the still-
// empty grid before the SSR-hydration branch (app.js `renderHome`) runs, producing a real, visible layout
// shift the instant the grid is then populated. A literal inline `<script>` (no `src`, so no fetch; no
// task boundary, since the parser executes it synchronously in place) closes that gap entirely: the grid
// is populated before the document's first paint, so there is nothing to shift. This delivers the EXACT
// SAME app.js file content the external tag would have loaded (no duplicated logic, no second source of
// truth) — only inline, and only for this one SSR-success response. `</script>` is defensively escaped
// (app.js carries none today, but this guards any future edit); it is our own trusted, server-owned
// static file, never user input, so this is a correctness guard, not an XSS control.
//
// FRAGILE MATCH: this regex matches the `<script src="/storefront/app.js" defer></script>` tag in
// `home.html` byte-for-byte (exact attribute order/spacing). A reformatting of that tag (e.g. reordered
// attributes, added whitespace) makes this a SILENT no-op — the `.replace` simply doesn't match, `/`
// keeps serving the external+deferred script, and the CLS regression this function exists to prevent
// comes back with no error anywhere. The only guard against that today is the storefront-catalog e2e
// asserting `script[src="/storefront/app.js"]` has zero count on `/` — if that assertion silently starts
// failing (or is ever loosened), this drift can land unnoticed.
const HOME_SCRIPT_TAG = /<script src="\/storefront\/app\.js" defer><\/script>/;
export function inlineStorefrontScript(html: string, js: string): string {
  const safeJs = js.replace(/<\/script/gi, "<\\/script");
  return html.replace(HOME_SCRIPT_TAG, () => `<script>${safeJs}</script>`);
}
