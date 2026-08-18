import type { FastifyInstance } from "fastify";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { themeStyleBlock, type ResolvedTheme } from "../widget-theme.js";

const here = dirname(fileURLToPath(import.meta.url));
const LOADER_ENTRY = join(here, "..", "..", "..", "widget", "src", "loader-entry.ts");

// esbuild's bundler resolves relative import specifiers literally — it does NOT know this repo's
// NodeNext convention of writing a `.js` specifier for a `.ts` source file (loader-entry.ts imports
// "./loader-core.js"). Without this plugin `bundleLoader()` fails: "could not resolve ./loader-core.js".
// tsc is unaffected — this plugin only changes what esbuild resolves, never what ships or type-checks.
const jsToTs = {
  name: "js-to-ts",
  setup(b: import("esbuild").PluginBuild) {
    b.onResolve({ filter: /^\.\.?\/.*\.js$/ }, (args) => ({
      path: join(args.resolveDir, args.path.replace(/\.js$/, ".ts")),
    }));
  },
};

// Perf hardening (deferred #287/#288 review minor): `bundleLoader()` is called once per `buildServer()`
// boot — once per prod process, but once per TEST BOOT too (200+ across this package's own suite). esbuild
// re-running a full bundle+minify pass on every one of those is pure waste: the entry point is a fixed
// file, never a request-time input, so the output can never differ within one process. Memoized at MODULE
// scope (not e.g. a closure inside `buildServer`) so it survives across every caller in this process.
// Cached as the in-flight PROMISE, not the resolved string, so concurrent early callers (a burst of test
// boots racing at process start) share the ONE build instead of each independently kicking off esbuild
// before the first has resolved.
let bundlePromise: Promise<string> | undefined;

/** Bundle the loader to a self-executing IIFE once, at boot — and only once per process (see above). */
export async function bundleLoader(): Promise<string> {
  if (!bundlePromise) {
    bundlePromise = build({
      entryPoints: [LOADER_ENTRY],
      bundle: true,
      format: "iife",
      minify: true,
      write: false,
      target: "es2019",
      logLevel: "silent",
      plugins: [jsToTs],
    }).then((out) => out.outputFiles[0]!.text);
  }
  return bundlePromise;
}

export interface EmbedDeps {
  loaderJs: string;
  panelHtml: string;
  /** Async so it can call `MerchantResolver.primaryDomainForShop` (custom-domain CSP support) before
   *  composing the header — server.ts's own registry/env lookup, never a second client-supplied param. */
  frameAncestors: (shop: string | undefined) => Promise<string>;
  /** WS10 — resolve the merchant brand theme for a shop (server-side; contrast-safe). */
  resolveThemeFor: (shop: string | undefined) => Promise<ResolvedTheme>;
}

export function registerEmbedRoutes(app: FastifyInstance, deps: EmbedDeps): void {
  app.get("/embed/loader.js", async (_req, reply) => {
    reply.header("content-type", "application/javascript; charset=utf-8");
    reply.header("cache-control", "public, max-age=300");
    return deps.loaderJs;
  });
  app.get("/embed/panel", async (req, reply) => {
    const shop = (req.query as { shop?: string })?.shop;
    reply.header("content-type", "text/html; charset=utf-8");
    reply.header("content-security-policy", `frame-ancestors ${await deps.frameAncestors(shop)}`);
    reply.removeHeader("x-frame-options");
    // WS10 — inject the merchant brand theme FOUC-free at the panel's <!--PALUP_THEME--> marker. Values are
    // validated hex (CSS) + JSON-escaped name/logo; a shop that doesn't resolve gets the default indigo theme.
    const theme = await deps.resolveThemeFor(shop);
    // Pin the embedded chat to the light scheme so it matches the light-toned storefront and never
    // darkens on a dark-OS shopper (owner directive). The raw widgetHtml served at /widget stays
    // unpinned, so the a11y suite keeps exercising the dark scheme there.
    return deps.panelHtml
      .replace("<!--PALUP_THEME-->", themeStyleBlock(theme))
      .replace('<html lang="en">', '<html lang="en" data-theme="light">');
  });
  // WS10 — the loader's shadow-DOM launcher (on the merchant page, cross-origin) fetches this to recolour
  // its bubble to the brand. JSON, cacheable, only the two colours the bubble needs — never a secret.
  app.get("/embed/theme", async (req, reply) => {
    const shop = (req.query as { shop?: string })?.shop;
    const theme = await deps.resolveThemeFor(shop);
    reply.header("content-type", "application/json; charset=utf-8");
    reply.header("cache-control", "public, max-age=300");
    reply.header("access-control-allow-origin", "*"); // read from the merchant page's origin; non-secret
    return { brand: theme.brand, brandInk: theme.brandInk };
  });
}
