import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// CLAUDE.md §3 NN#2: "No self-improving agent ships to 100% of traffic without ... a human promotion.
// The only path to prod is propose -> eval gate -> shadow(0%) -> canary(1-5%) -> human approve ->
// promote -> monitored." §4 step 5: "prod is progressive (canary -> full)" and "Prod is never
// auto-deployed" — promotion to production is a human action, never a CI/CD trigger.
//
// This enumerates every workflow under .github/workflows/ and asserts NONE of them deploys to a
// production target. Today (2026-08-20/21) the only deploy workflow is deploy-staging.yml, targeting the
// Cloud Run service `palup-widget-staging`; drift-check.yml and eval-quality.yml run evals/smokes and
// upload report artifacts, they do not deploy anything. This is the machine check for that gap: a future
// PR that adds a `deploy-prod.yml`, or that repoints deploy-staging.yml's `gcloud run deploy` at a
// production-named service, is caught here instead of shipping the very NN#2 violation CLAUDE.md exists
// to prevent.
//
// SAME "no YAML dependency" convention as packages/widget-backend/test/deploy-staging-env.test.ts and
// merge-gate-no-weaken-consistency.test.ts: text/regex scanning over the raw workflow source, not a YAML
// parse.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

const WORKFLOWS_DIR = fileURLToPath(new URL("../../../.github/workflows/", import.meta.url));

const workflowFiles = readdirSync(WORKFLOWS_DIR)
  .filter((f) => (f.endsWith(".yml") || f.endsWith(".yaml")) && statSync(join(WORKFLOWS_DIR, f)).isFile())
  .sort();

/** Deploy-shaped commands: anything that would push a build/revision to a live serving target. */
const DEPLOY_COMMAND_RE = /gcloud (run deploy|run services update|app deploy)|kubectl (apply|rollout)|firebase deploy/;

/** Anything naming a production target, by convention or by the literal word "prod"/"production". */
const PROD_TARGET_RE = /\bprod(uction)?\b/i;

describe("no-auto-prod — no GitHub Actions workflow deploys to a production target", () => {
  it("at least one workflow file exists (else this scan is vacuous)", () => {
    expect(workflowFiles.length).toBeGreaterThan(0);
  });

  it("exactly the known workflow set exists today (documents drift instead of hiding it)", () => {
    // Not a hard allowlist gate (a new workflow file is not itself a violation) — a change to this list
    // just means a human should re-read this file's other assertions against the new workflow's content,
    // which the per-file checks below do unconditionally regardless of what is in this array.
    expect(workflowFiles).toEqual(["ci.yml", "deploy-staging.yml", "drift-check.yml", "eval-quality.yml"]);
  });

  it.each(workflowFiles)("%s contains no deploy command targeting anything named prod/production", (file) => {
    const src = readFileSync(join(WORKFLOWS_DIR, file), "utf8");
    const lines = src.split("\n");
    for (const line of lines) {
      if (DEPLOY_COMMAND_RE.test(line) && PROD_TARGET_RE.test(line)) {
        throw new Error(`${file} has a deploy command naming a production target: ${line.trim()}`);
      }
    }
  });

  it("ci.yml (the gate ci.yml/deploy-staging.yml key off) runs no deploy command at all", () => {
    const src = readFileSync(join(WORKFLOWS_DIR, "ci.yml"), "utf8");
    expect(src).not.toMatch(DEPLOY_COMMAND_RE);
  });

  it("drift-check.yml and eval-quality.yml run no deploy command — smoke/eval only, no serving-target writes", () => {
    for (const file of ["drift-check.yml", "eval-quality.yml"]) {
      const src = readFileSync(join(WORKFLOWS_DIR, file), "utf8");
      expect(src, `${file} should contain no deploy command`).not.toMatch(DEPLOY_COMMAND_RE);
    }
  });

  it("deploy-staging.yml is the only workflow with a deploy command, and it targets the staging Cloud Run service by its exact name", () => {
    const deployers = workflowFiles.filter((f) => DEPLOY_COMMAND_RE.test(readFileSync(join(WORKFLOWS_DIR, f), "utf8")));
    expect(deployers).toEqual(["deploy-staging.yml"]);

    const src = readFileSync(join(WORKFLOWS_DIR, "deploy-staging.yml"), "utf8");
    expect(src).toContain("gcloud run deploy palup-widget-staging");
    // Belt-and-suspenders: the exact service name contains "staging" and not "prod"/"production".
    expect("palup-widget-staging").toMatch(/staging/);
    expect("palup-widget-staging").not.toMatch(PROD_TARGET_RE);
  });

  it("deploy-staging.yml documents (in its own header) that prod is never auto-deployed", () => {
    const src = readFileSync(join(WORKFLOWS_DIR, "deploy-staging.yml"), "utf8");
    // The sentence wraps across a comment line break in the file ("Production is\n# never
    // auto-deployed."), so allow whitespace/comment noise between the two halves.
    expect(src).toMatch(/[Pp]roduction is[\s#]*never auto-deployed/);
  });

  it("no workflow references a GCP project/service whose name suggests production", () => {
    // Catches the case where a workflow deploys via a project id or --project flag pointing at a
    // prod-named GCP project even if the Cloud Run *service* name itself looks innocuous.
    for (const file of workflowFiles) {
      const src = readFileSync(join(WORKFLOWS_DIR, file), "utf8");
      const projectRefs = src.match(/--project[= ]["']?[\w.-]*prod[\w.-]*/gi) ?? [];
      expect(projectRefs, `${file} references a prod-named --project value: ${JSON.stringify(projectRefs)}`).toEqual([]);
    }
  });
});
