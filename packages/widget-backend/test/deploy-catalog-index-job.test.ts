import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// S3 §E — the scheduled backstop's runbook, guarded. Mirrors deploy-staging-env.test.ts: a TEXT assertion
// that the DEPLOY.md runbook still names the job, its command, its cloudsql attachment, its DB secret, the
// least-privilege invoker SA, and the hourly scheduler — and that it adds NO serving flag. It does NOT
// prove a deploy works (only a real `gcloud` apply does); it proves the runbook has not silently lost a
// load-bearing line, the same failure class the sweep runbook has already hit.

const DEPLOY = fileURLToPath(new URL("../../../docs/DEPLOY.md", import.meta.url));
const md = readFileSync(DEPLOY, "utf8");

const REQUIRED_LINES: Array<[fragment: string, why: string]> = [
  ["gcloud run jobs deploy palup-catalog-index", "the Cloud Run Job that runs the backstop reconcile"],
  ["--command pnpm --args catalog:index", "overrides the image CMD to run the catalog index CLI"],
  ["--set-cloudsql-instances palup-jason:us-central1:palup-staging", "the same Cloud SQL the backend uses (else a per-process store that dies)"],
  ["DATABASE_URL=palup-staging-database-url:latest", "the durable store secret"],
  ["gcloud iam service-accounts create palup-catalog-index-invoker", "the least-privilege invoker SA"],
  ["--role=\"roles/run.invoker\"", "the ONLY role the invoker gets"],
  ["gcloud scheduler jobs create http palup-catalog-index-hourly", "the hourly Cloud Scheduler trigger"],
  ["palup-catalog-index:run", "the run URI the scheduler POSTs to"],
];

describe("S3 §E — DEPLOY.md carries the catalog-index backstop job runbook", () => {
  it.each(REQUIRED_LINES)("names %s (%s)", (fragment) => {
    expect(md).toContain(fragment);
  });

  it("the catalog-index job section adds NO serving flag", () => {
    const start = md.indexOf("gcloud run jobs deploy palup-catalog-index");
    expect(start).toBeGreaterThan(-1);
    const section = md.slice(start, start + 1600);
    for (const flag of ["CATALOG_RETRIEVAL", "VECTOR_ANN", "PRODUCT_FACTS_HYDRATION", "MEMORY_ADR_ACCEPTED"]) {
      expect(section).not.toContain(flag);
    }
  });

  it("runs hourly (a 5-field cron whose minute is fixed and hour is a wildcard)", () => {
    expect(md).toMatch(/--schedule="\d{1,2} \* \* \* \*"/);
  });
});
