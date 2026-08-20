import { describe, it, expect } from "vitest";
import { isGovernanceRulesFile, findGovernanceRuleChanges, decideGovernanceGate } from "../src/governance-guard.js";

// Tests the PURE decision logic merge-gate.sh's CLI wrapper (governance-guard.ts's stdin/env block) shells
// out to — no `gh` call, no git checkout, no process spawn needed to exercise the actual classification.

describe("isGovernanceRulesFile — exact-match, precise (not a directory prefix)", () => {
  it("matches the rules files named in CLAUDE.md §3/§4 and the gate itself", () => {
    expect(isGovernanceRulesFile("CLAUDE.md")).toBe(true);
    expect(isGovernanceRulesFile("docs/HITL-POLICY.md")).toBe(true);
    expect(isGovernanceRulesFile(".claude/scripts/merge-gate.sh")).toBe(true);
  });

  it("matches the eval-gate and evolution-pipeline gate modules", () => {
    expect(isGovernanceRulesFile("packages/eval/src/run.ts")).toBe(true);
    expect(isGovernanceRulesFile("packages/evolution/src/engine.ts")).toBe(true);
  });

  it("does NOT match an ADR — status reconciles are ordinary, auto-mergeable doc edits", () => {
    expect(isGovernanceRulesFile("docs/adr/0018-customer-account-api.md")).toBe(false);
    expect(isGovernanceRulesFile("docs/adr/0001-portability-over-google-native.md")).toBe(false);
  });

  it("does NOT match ordinary code, tests, or docs", () => {
    expect(isGovernanceRulesFile("packages/widget/src/loader-core.ts")).toBe(false);
    expect(isGovernanceRulesFile("packages/eval/test/gate.test.ts")).toBe(false);
    expect(isGovernanceRulesFile("docs/DEPLOY.md")).toBe(false);
    expect(isGovernanceRulesFile("README.md")).toBe(false);
  });

  it("does NOT over-match the rest of packages/eval or packages/evolution", () => {
    // Only the two named gate modules are governance-rules files; case data, suites, and other eval/
    // evolution source are ordinary (numeric threshold edits are separately caught by merge-gate.sh's
    // existing THRESHOLD_REVIEWED check, which is a lighter-touch review-and-override, not a refuse).
    expect(isGovernanceRulesFile("packages/eval/src/suites.ts")).toBe(false);
    expect(isGovernanceRulesFile("packages/eval/src/floor.ts")).toBe(false);
    expect(isGovernanceRulesFile("packages/eval/cases/core.json")).toBe(false);
    expect(isGovernanceRulesFile("packages/evolution/src/types.ts")).toBe(false);
    expect(isGovernanceRulesFile("packages/evolution/src/proposer.ts")).toBe(false);
  });

  it("does not match on filename alone — path must match exactly (no basename-only match)", () => {
    expect(isGovernanceRulesFile("merge-gate.sh")).toBe(false);
    expect(isGovernanceRulesFile("some/other/dir/CLAUDE.md")).toBe(false);
  });
});

describe("findGovernanceRuleChanges — filters a changed-file list down to the governed subset", () => {
  it("returns only the governance-rules files, preserving order", () => {
    const files = [
      "packages/widget/src/loader-core.ts",
      "CLAUDE.md",
      "docs/adr/0022-something.md",
      ".claude/scripts/merge-gate.sh",
    ];
    expect(findGovernanceRuleChanges(files)).toEqual(["CLAUDE.md", ".claude/scripts/merge-gate.sh"]);
  });

  it("returns an empty array when nothing governed is touched", () => {
    expect(findGovernanceRuleChanges(["docs/adr/0018-x.md", "packages/widget/src/foo.ts"])).toEqual([]);
  });
});

describe("decideGovernanceGate — the exact refuse/allow decision merge-gate.sh acts on", () => {
  it("REFUSES a governance-rules file (CLAUDE.md) without the human-approval flag", () => {
    const d = decideGovernanceGate(["CLAUDE.md"], false);
    expect(d.refuse).toBe(true);
    expect(d.matched).toEqual(["CLAUDE.md"]);
  });

  it("REFUSES an edit to the gate itself (merge-gate.sh) without the flag — the self-consistency case", () => {
    const d = decideGovernanceGate([".claude/scripts/merge-gate.sh", "packages/eval/test/governance-guard.test.ts"], false);
    expect(d.refuse).toBe(true);
    expect(d.matched).toEqual([".claude/scripts/merge-gate.sh"]);
  });

  it("ALLOWS an ADR status reconcile (docs/adr/0018-x.md) with no flag needed", () => {
    const d = decideGovernanceGate(["docs/adr/0018-x.md"], false);
    expect(d.refuse).toBe(false);
    expect(d.matched).toEqual([]);
  });

  it("ALLOWS an ordinary file with no flag needed", () => {
    const d = decideGovernanceGate(["packages/widget-backend/src/server.ts"], false);
    expect(d.refuse).toBe(false);
    expect(d.matched).toEqual([]);
  });

  it("ALLOWS a governance-rules file change once GOVERNANCE_HUMAN_APPROVED is set (flag set -> allow)", () => {
    const d = decideGovernanceGate(["CLAUDE.md", "packages/evolution/src/engine.ts"], true);
    expect(d.refuse).toBe(false);
    // matched is still reported (not a silent bypass) even though the merge is allowed.
    expect(d.matched).toEqual(["CLAUDE.md", "packages/evolution/src/engine.ts"]);
  });

  it("ALLOWS a mixed PR that touches only non-governed files, flag or no flag", () => {
    const files = ["docs/adr/0020-x.md", "packages/widget/src/foo.ts", "docs/DEPLOY.md"];
    expect(decideGovernanceGate(files, false).refuse).toBe(false);
    expect(decideGovernanceGate(files, true).refuse).toBe(false);
  });
});
