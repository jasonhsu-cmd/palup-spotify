import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// The no-weakening invariant, machine-checked: merge-gate.sh HARDCODES its own copy of the eight gate
// step names (the `EXPECT` array) specifically so a PR that deletes a step from ci.yml is measured
// against merge-gate.sh's UNCHANGED definition, not the PR's own weakened one (see merge-gate.sh's own
// comment above EXPECT: "never derived from the PR's own ci.yml, or a PR that deletes a gate step would
// be measured against its own weakened definition").
//
// That invariant only holds today because the two lists actually agree. This test is the drift check:
// if a future PR renames or removes a step in ci.yml WITHOUT updating merge-gate.sh's EXPECT (or vice
// versa), the two silently diverge and the no-weakening check's own `grep -E "$(IFS='|'; echo
// "${EXPECT[*]}")"` scan against the PR's diff stops meaning what it claims to mean. This does not run
// the gate steps or ci.yml — it only asserts the two step-name lists are the same set of names today.
//
// WHY TEXT PARSING, NOT A SHELL/YAML PARSER: mirrors packages/widget-backend/test/deploy-staging-env.test.ts
// — this repo has no YAML dependency (checked package.json and every packages/*/package.json), and the
// failure this must catch is a NAME changing or a STEP disappearing, which substring/regex extraction
// catches exactly.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

const GATE_SH = fileURLToPath(new URL("../../../.claude/scripts/merge-gate.sh", import.meta.url));
const CI_YML = fileURLToPath(new URL("../../../.github/workflows/ci.yml", import.meta.url));

const gateSrc = readFileSync(GATE_SH, "utf8");
const ciSrc = readFileSync(CI_YML, "utf8");

/**
 * Pull the quoted step names out of merge-gate.sh's `EXPECT=(\n  "..."\n  ...\n)` array literal.
 * Line-based (not a single greedy/non-greedy regex over the whole match) because several step names
 * contain their OWN parentheses (e.g. "Self-improvement eval gate (safety floor + no-regression)") —
 * a naive `EXPECT=\(([\s\S]*?)\)` would stop at that inner `)` instead of the array's real close. The
 * array's actual closing paren is the only one that sits alone on its own line, so that is what this
 * scans for.
 */
function extractExpectArray(src: string): string[] {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => l.trim().startsWith("EXPECT=("));
  if (start === -1) throw new Error("could not find the EXPECT=( ... ) array in merge-gate.sh");
  const names: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === ")") return names; // the array's real close: a lone ')' on its own line
    const m = line.match(/^\s*"([^"]+)"\s*$/);
    if (m) names.push(m[1]);
  }
  throw new Error("EXPECT=( ... ) array in merge-gate.sh never closes with a lone ')' line");
}

/** Pull every `- name: ...` GitHub Actions step name out of ci.yml. */
function extractCiStepNames(src: string): string[] {
  const re = /^\s*- name:\s*(.+)$/gm;
  const names: string[] = [];
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(src))) names.push(mm[1].trim());
  return names;
}

describe("merge-gate.sh's hardcoded EXPECT array stays consistent with ci.yml's step names", () => {
  it("merge-gate.sh actually declares gate steps (else this test is vacuous)", () => {
    const expect_ = extractExpectArray(gateSrc);
    expect(expect_.length).toBeGreaterThanOrEqual(8);
  });

  it("ci.yml actually declares named steps (else this test is vacuous)", () => {
    const ciSteps = extractCiStepNames(ciSrc);
    expect(ciSteps.length).toBeGreaterThanOrEqual(8);
  });

  it("every EXPECT name appears as a step name in ci.yml — nothing has been silently renamed or dropped", () => {
    const expect_ = extractExpectArray(gateSrc);
    const ciSteps = extractCiStepNames(ciSrc);
    for (const name of expect_) {
      expect(ciSteps, `EXPECT entry "${name}" is missing from ci.yml's step names — a PR may have ` +
        `renamed or deleted this gate step in ci.yml without updating merge-gate.sh's EXPECT, which ` +
        `would make the no-weakening deletion-scan compare against a name ci.yml no longer has.`).toContain(name);
    }
  });

  it("ci.yml has no gate step that EXPECT does not also know about (the reverse direction)", () => {
    // ci.yml has exactly one non-gate housekeeping step ("Install Playwright browser") that EXPECT
    // deliberately excludes — it is setup, not a pass/fail gate. Anything else appearing only in ci.yml
    // and not in EXPECT means merge-gate.sh is not actually running (or diff-guarding) a real CI step.
    const expect_ = new Set(extractExpectArray(gateSrc));
    const ciSteps = extractCiStepNames(ciSrc);
    const known_non_gate_steps = new Set(["Install Playwright browser"]);
    const unknown = ciSteps.filter((s) => !expect_.has(s) && !known_non_gate_steps.has(s));
    expect(unknown, `ci.yml step(s) not represented in merge-gate.sh's EXPECT and not in the known ` +
      `non-gate allowlist: ${JSON.stringify(unknown)}. Either it's a new gate step EXPECT must include, ` +
      `or it's housekeeping that belongs in known_non_gate_steps.`).toEqual([]);
  });

  it("the local gate_step calls in merge-gate.sh use the SAME literal names as EXPECT (they gate what they claim to)", () => {
    // merge-gate.sh runs `gate_step "<name>" "<cmd>"` locally using the same string literals as EXPECT
    // (see its own comment: EXPECT is "Used TWICE below: to run the gate locally, and ... to guard
    // against a PR deleting these names from ci.yml"). If a gate_step call's label drifted from EXPECT,
    // the local run and the no-weakening scan would silently stop describing the same step.
    const expect_ = extractExpectArray(gateSrc);
    for (const name of expect_) {
      expect(gateSrc, `gate_step "${name}" ... not found — EXPECT and the local gate_step calls have drifted`)
        .toContain(`gate_step "${name}"`);
    }
  });
});
