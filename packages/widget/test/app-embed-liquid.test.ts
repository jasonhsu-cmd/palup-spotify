import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const liquid = readFileSync(join(here, "..", "..", "..", "extensions", "palup-widget", "blocks", "app-embed.liquid"), "utf8");

describe("app-embed block", () => {
  it("renders the loader script with shop + position and a position setting", () => {
    expect(liquid).toMatch(/<script[^>]+src=.+\/embed\/loader\.js/);
    expect(liquid).toContain('data-shop="{{ shop.permanent_domain }}"');
    expect(liquid).toContain("data-position=");
    expect(liquid).toMatch(/"type"\s*:\s*"select"[\s\S]*"id"\s*:\s*"position"/);
    expect(liquid).toContain('"target": "body"');
  });
});
