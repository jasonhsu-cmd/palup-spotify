// Layer 2 — FULL live-browser case-set runner against the deployed staging widget.
//
// Builds on the working smoke (`e2e/tests/widget-behavioral-live.spec.ts`, commit 0091a9a) but is a
// standalone script (not a Playwright `test()` file) because this needs things the test-runner fixture
// model fights: per-case ×3 repeats with a FRESH browser context each time, continuing past a failed
// case instead of aborting the file, and incremental disk writes so a crash partway through doesn't
// lose completed runs. Shares the closed-shadow-DOM / same-origin-iframe mechanics with the smoke via
// `e2e/lib/widget-layer2-helpers.ts` — no reimplementation.
//
// Run: `pnpm e2e:layer2:full` (see package.json). Real staging inference — see
// `e2e/fixtures/widget-layer2-cases.json` for the case set and the design doc
// (docs/superpowers/specs/2026-08-20-widget-e2e-behavioral-test-design.md §4-§6) for why these cases
// and this budget (~120-140 real /chat calls: 21 cases, mostly single-turn, ×3 repeats for stability).
//
// Output: reports/layer2-live-run.json (gitignored — see docs/widget-test-report.md and the
// full report at .superpowers/sdd/2026-08-20-widget-behavioral-harness-layer1/layer2-full-report.md
// for the committed synthesis). A separate script, packages/eval/src/widget-behavioral/layer2-judge-run.ts,
// reads this file and judges the captured real prose (kept separate because only packages/eval has a
// resolvable `@palup/judge` dependency; this script lives under e2e/ which does not).

import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { openPanel, sendMessage, collectChatResponses, type ChatResponse } from "../lib/widget-layer2-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const STAGING_BASE_URL = "https://palup-widget-staging-270594351425.us-central1.run.app";
// Overridable for a cheap dry run (e.g. `LAYER2_REPEATS=1 LAYER2_CASE_LIMIT=1 pnpm e2e:layer2:full`)
// without touching the real case set or spending the full ~135-call budget.
const REPEATS = Number(process.env.LAYER2_REPEATS ?? 3);
const CASE_LIMIT = process.env.LAYER2_CASE_LIMIT ? Number(process.env.LAYER2_CASE_LIMIT) : undefined;

type Expect = {
  modeIn?: string[];
  perTurnModeIn?: string[];
  pitchMustBeNone?: boolean;
  escalate?: boolean;
  expectCards?: boolean;
  expectConsentPromptSpecial?: boolean;
  mustNotTextContains?: string[];
};

type Layer2Case = {
  id: string;
  riskClass: string;
  turns: string[];
  expect: Expect;
  judge: { dimensions: string[]; rubric: string };
  note?: string;
};

type TurnRecord = {
  turn: number;
  message: string;
  response: ChatResponse;
};

type StructuralResult = { pass: boolean; failures: string[] };

type CaseRunRecord = {
  caseId: string;
  riskClass: string;
  rep: number;
  sessionTag: string;
  ok: boolean;
  error?: string;
  turnRecords?: TurnRecord[];
  structural?: StructuralResult;
  greetingResponse?: ChatResponse;
};

function gradeStructural(expect: Expect, turnRecords: TurnRecord[]): StructuralResult {
  const failures: string[] = [];
  const last = turnRecords[turnRecords.length - 1]?.response ?? {};
  if (expect.modeIn && !expect.modeIn.includes(String(last.mode))) {
    failures.push(`mode: expected one of [${expect.modeIn.join(", ")}], got ${last.mode}`);
  }
  if (expect.perTurnModeIn) {
    expect.perTurnModeIn.forEach((wantMode, i) => {
      const actualMode = turnRecords[i]?.response.mode;
      if (actualMode !== wantMode) {
        failures.push(`turn ${i + 1} mode: expected ${wantMode}, got ${actualMode}`);
      }
    });
  }
  if (expect.pitchMustBeNone === true && last.pitch !== "none") {
    failures.push(`pitch: expected "none", got ${last.pitch}`);
  }
  if (expect.pitchMustBeNone === false && last.pitch === "none") {
    failures.push(`pitch: expected a real pitch (not "none"), got "none"`);
  }
  if (expect.escalate !== undefined && Boolean(last.escalate) !== expect.escalate) {
    failures.push(`escalate: expected ${expect.escalate}, got ${Boolean(last.escalate)}`);
  }
  if (expect.expectCards === true) {
    const cards = last.recommendedProductCards;
    if (!Array.isArray(cards) || cards.length === 0) {
      failures.push(`expected recommendedProductCards to be non-empty, got ${JSON.stringify(cards)}`);
    }
  }
  if (expect.expectConsentPromptSpecial === true && last.consentPrompt !== "special") {
    failures.push(`expected consentPrompt "special", got ${JSON.stringify(last.consentPrompt)}`);
  }
  if (expect.mustNotTextContains) {
    const replyLower = (last.reply ?? "").toLowerCase();
    for (const token of expect.mustNotTextContains) {
      if (replyLower.includes(token.toLowerCase())) {
        failures.push(`mustNot violated: reply contains "${token}"`);
      }
    }
  }
  return { pass: failures.length === 0, failures };
}

async function main() {
  const allCases = JSON.parse(
    readFileSync(join(repoRoot, "e2e", "fixtures", "widget-layer2-cases.json"), "utf8"),
  ) as Layer2Case[];
  const cases = CASE_LIMIT ? allCases.slice(0, CASE_LIMIT) : allCases;

  const outDir = join(repoRoot, "reports");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "layer2-live-run.json");

  const records: CaseRunRecord[] = [];
  let totalChatCalls = 0;

  const browser = await chromium.launch();
  try {
    for (const c of cases) {
      for (let rep = 1; rep <= REPEATS; rep++) {
        const sessionTag = `layer2-full:${c.id}:rep${rep}`;
        console.log(`\n=== ${sessionTag} ===`);
        const context = await browser.newContext({ baseURL: STAGING_BASE_URL });
        try {
          const page = await context.newPage();
          const chatResponses = collectChatResponses(page);
          const frame = await openPanel(page, chatResponses);
          const greetingResponse = chatResponses[0];
          totalChatCalls += 1; // greeting

          const turnRecords: TurnRecord[] = [];
          for (let i = 0; i < c.turns.length; i++) {
            const response = await sendMessage(page, frame, chatResponses, c.turns[i], sessionTag);
            totalChatCalls += 1;
            turnRecords.push({ turn: i + 1, message: c.turns[i], response });
            console.log(
              `  turn ${i + 1}: mode=${response.mode} pitch=${response.pitch} escalate=${response.escalate}`,
            );
          }

          const structural = gradeStructural(c.expect, turnRecords);
          console.log(`  structural: ${structural.pass ? "PASS" : "FAIL " + structural.failures.join("; ")}`);

          records.push({
            caseId: c.id,
            riskClass: c.riskClass,
            rep,
            sessionTag,
            ok: true,
            turnRecords,
            structural,
            greetingResponse,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`  ERROR: ${message}`);
          records.push({ caseId: c.id, riskClass: c.riskClass, rep, sessionTag, ok: false, error: message });
        } finally {
          await context.close();
          // Incremental write after every run so a crash partway through loses nothing already done.
          writeFileSync(
            outPath,
            JSON.stringify({ generatedAt: new Date().toISOString(), totalChatCalls, records }, null, 2),
          );
        }
      }
    }
  } finally {
    await browser.close();
  }

  const okCount = records.filter((r) => r.ok).length;
  const structuralPassCount = records.filter((r) => r.ok && r.structural?.pass).length;
  console.log(`\n=== DONE ===`);
  console.log(`case-runs: ${records.length} (${okCount} ok, ${records.length - okCount} errored)`);
  console.log(`structural pass: ${structuralPassCount}/${okCount}`);
  console.log(`total real /chat calls made: ${totalChatCalls}`);
  console.log(`output: ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
