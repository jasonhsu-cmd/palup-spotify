import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALLOWED_CLAIMS,
  REPO,
  SHOPPER_SURFACES,
  rel,
  report,
  scan,
  stripComments,
  tsFilesUnder,
  type Violation,
} from "./shopper-promise-guard.js";

// The assertions for the shopper-promise guard. The scanner, the claim classes, the mechanism registry
// and the full rationale live in ./shopper-promise-guard.ts (kept importable, not inlined, so it can be
// exercised against synthetic sources — the mutation tests below — and reused by a future CI step).

describe("the shopper-promise guard", () => {
  it("no shopper-visible text claims a capability this system does not have", () => {
    const violations = scan(SHOPPER_SURFACES);
    expect(violations.map(report).join("\n"), `${violations.length} over-promise(s) reached shopper-visible text`).toBe("");
  });

  it("every allowed claim still exists, and the mechanism it names really exists outside comments", () => {
    const problems: string[] = [];
    for (const a of ALLOWED_CLAIMS) {
      const surface = SHOPPER_SURFACES.find((f) => f.path === a.surface);
      if (!surface) {
        problems.push(`ALLOWED_CLAIMS entry names a file that is not a scanned surface: ${a.surface}`);
        continue;
      }
      if (!stripComments(surface.source).includes(a.claim)) {
        problems.push(
          `STALE ALLOWED_CLAIMS entry: "${a.claim}" no longer appears in ${a.surface}. Delete the entry — ` +
            `a registry of claims that no longer exist is how a guard rots into a rubber stamp.`,
        );
      }
      const mech = stripComments(readFileSync(join(REPO, a.mechanismFile), "utf8"));
      if (!mech.includes(a.symbol)) {
        problems.push(
          `BROKEN MECHANISM: "${a.claim}" is allowed because of \`${a.symbol}\` in ${a.mechanismFile}, but that ` +
            `symbol does not appear there outside comments. Either the mechanism was removed (then the claim ` +
            `is now a lie and must be reworded) or the entry was never true.`,
        );
      }
    }
    expect(problems.join("\n")).toBe("");
  });

  // ── Mutation tests: proof the guard is live, not vacuous ────────────────────────────────────────
  it("MUTATION — a plausible new handoff over-promise spliced into the REAL widget goes red", () => {
    const widget = SHOPPER_SURFACES.find((f) => f.path === "packages/widget/public/index.html");
    expect(widget, "the widget must be a scanned surface").toBeDefined();
    const original = (widget as { source: string }).source;
    const mutated = original.replace('el.className = "handoff";', 'el.className = "handoff"; el.textContent = "A specialist is joining now.";');
    expect(mutated, "the splice point must exist, or this mutation proves nothing").not.toBe(original);
    const v = scan([{ path: "packages/widget/public/index.html", source: mutated }]);
    expect(v.map((x) => x.klass.id)).toContain("live-human-joins-this-chat");
    // The failure message has to tell the author WHAT is missing and WHAT to do about it.
    const printed = v.map(report).join("\n");
    expect(printed).toMatch(/there is no live-agent channel/);
    expect(printed).toMatch(/reword to what escalation actually does/);
  });

  it("MUTATION — a plausible new erasure over-promise spliced into the REAL brain goes red", () => {
    const brain = SHOPPER_SURFACES.find((f) => f.path === "packages/widget-brain/src/brain.ts");
    expect(brain, "the brain must be a scanned surface").toBeDefined();
    const original = (brain as { source: string }).source;
    const mutated = original.replace("you have the right to have your data deleted", "your data has been permanently erased");
    expect(mutated, "the splice point must exist, or this mutation proves nothing").not.toBe(original);
    const ids = scan([{ path: "packages/widget-brain/src/brain.ts", source: mutated }]).map((x) => x.klass.id);
    expect(ids).toContain("absolute-or-instant-erasure");
  });

  it("MUTATION — every claim class fires on a fresh sentence in that class", () => {
    const samples: Array<[string, string]> = [
      ["live-human-joins-this-chat", 'const r = "A team member is joining this chat.";'],
      ["human-is-working-on-it-right-now", 'const r = "A member of our team is looking into this for you.";'],
      ["conversation-handed-to-a-human", 'const r = "They will see the whole conversation.";'],
      ["data-export", 'const r = "I can send you a copy of your data.";'],
      ["storage-denial", 'const r = "We never store your messages.";'],
      ["absolute-or-instant-erasure", 'const r = "Your details were permanently deleted.";'],
      ["unqualified-guarantee", 'const r = "This is guaranteed to arrive Friday.";'],
      ["completed-action", 'const r = "Done — I\'ve refunded your order.";'],
    ];
    for (const [id, source] of samples) {
      const ids = scan([{ path: "packages/widget-brain/src/brain.ts", source }]).map((x) => x.klass.id);
      expect(ids, `claim class ${id} did not fire on: ${source}`).toContain(id);
    }
  });

  it("the guard cannot be satisfied by moving the string somewhere it does not look", () => {
    // The surface list is a GLOB over the three packages that can render shopper text, so a file added
    // tomorrow is scanned automatically — the list is computed, never written down.
    const brainFiles = tsFilesUnder("packages/widget-brain/src").map(rel);
    expect(brainFiles.length).toBeGreaterThan(5);
    for (const f of brainFiles) expect(SHOPPER_SURFACES.map((l) => l.path)).toContain(f);
    const hypothetical = scan([
      { path: "packages/widget-brain/src/brand-new-copy.ts", source: 'export const x = "A person is joining this chat.";' },
    ]);
    expect(hypothetical.length).toBeGreaterThan(0);
    expect(hypothetical.map((v) => v.klass.id)).toContain("live-human-joins-this-chat");
  });

  // ── The comment-stripper's own honesty ─────────────────────────────────────────────────────────
  it("comments are exempt (they are not shopper-visible) but line numbers survive the blanking", () => {
    const src = ["// a person is joining this chat", "const a = 1;", 'const reply = "A person is joining this chat.";'].join("\n");
    const v = scan([{ path: "packages/widget-brain/src/x.ts", source: src }]);
    expect(v.length).toBeGreaterThan(0);
    expect(new Set(v.map((x) => x.line)), "only the code line, and it must report line 3").toEqual(new Set([3]));
  });

  it("the stripper does not eat text inside strings or regexes (which would hide a real claim)", () => {
    const src = 'const u = "https://x/y"; const re = /don\'?t (store|keep)/; const reply = "We never store your notes.";';
    const ids = scan([{ path: "packages/widget-brain/src/x.ts", source: src }]).map((x) => x.klass.id);
    expect(ids).toContain("storage-denial");
    expect(stripComments(src)).toContain("https://x/y");
  });

  it("blanking preserves every line of the real widget, so reported line numbers are the real ones", () => {
    const widget = SHOPPER_SURFACES.find((f) => f.path === "packages/widget/public/index.html") as { source: string };
    expect(stripComments(widget.source).split("\n")).toHaveLength(widget.source.split("\n").length);
  });

  it("a registered claim exempts its own sentence only, never the rest of the line", () => {
    // The hole this closes, found by the brain mutation test above: shopper replies are single long
    // source lines, so a line-level exemption let one allowed claim ("I've recorded your request") cover
    // an unrelated over-promise sitting in the same string.
    const src =
      'const reply = "I\'ve recorded your request, and your data has been permanently erased.";';
    const ids = scan([{ path: "packages/widget-brain/src/brain.ts", source: src }]).map((x) => x.klass.id);
    expect(ids).toContain("absolute-or-instant-erasure");
    expect(ids, "the registered claim itself stays exempt").not.toContain("completed-action");
  });

  it("a DENIED claim is not a promise (the negation window)", () => {
    const src = 'const reply = "I can\'t guarantee a product is safe for a specific allergy.";';
    expect(scan([{ path: "packages/widget-brain/src/x.ts", source: src }])).toHaveLength(0);
  });

  it("reports enough to find the string: file, line and the matched text", () => {
    const v = scan([{ path: "packages/widget-brain/src/x.ts", source: '\n\nconst r = "A person is joining this chat.";' }]);
    const first = v[0] as Violation;
    expect(first.file).toBe("packages/widget-brain/src/x.ts");
    expect(first.line).toBe(3);
    expect(first.matched.toLowerCase()).toContain("joining this chat");
  });
});
