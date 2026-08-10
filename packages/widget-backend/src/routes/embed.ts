import type { FastifyInstance } from "fastify";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

/** Bundle the loader to a self-executing IIFE once, at boot. */
export async function bundleLoader(): Promise<string> {
  const out = await build({
    entryPoints: [LOADER_ENTRY],
    bundle: true,
    format: "iife",
    minify: true,
    write: false,
    target: "es2019",
    logLevel: "silent",
    plugins: [jsToTs],
  });
  return out.outputFiles[0]!.text;
}

export interface EmbedDeps {
  loaderJs: string;
  panelHtml: string;
  /** Async so it can call `MerchantResolver.primaryDomainForShop` (custom-domain CSP support) before
   *  composing the header — server.ts's own registry/env lookup, never a second client-supplied param. */
  frameAncestors: (shop: string | undefined) => Promise<string>;
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
    return deps.panelHtml;
  });
}
