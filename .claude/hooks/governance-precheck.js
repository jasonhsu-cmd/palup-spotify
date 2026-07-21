#!/usr/bin/env node
/**
 * PalUp governance pre-check (advisory PreToolUse hook).
 *
 * Reads the Claude Code hook payload from stdin. When an edit touches a
 * governance-sensitive area, it prints a reminder to stderr so the change is made
 * with the right guardrails in mind. It is intentionally ADVISORY (exit 0): the real
 * enforcement lives in code, tests, `security-reviewer`, and `/governance-check`.
 *
 * To make it BLOCKING for a given pattern, exit with code 2 and print the reason.
 */
let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let path = '';
  try {
    const payload = JSON.parse(raw || '{}');
    path = payload?.tool_input?.file_path || payload?.tool_input?.path || '';
  } catch { /* ignore malformed payloads */ }

  const rules = [
    [/agent-runtime|\/agents?\//i,
      'Run-time agent behavior: must enter the evolution pipeline (docs/AGENT-GOVERNANCE.md); no self-promote, no gate-skip.'],
    [/platform-ports/i,
      'Platform port: keep the interface provider-neutral; vendor SDKs only in adapters (ADR-0001 / portability-guard).'],
    [/approval|hitl|policy/i,
      'HITL surface: boundary-crossing actions must route to the Approval Center, never auto-execute (docs/HITL-POLICY.md).'],
    [/payment|billing|payout|refund|price|pricing/i,
      'Money path: this almost certainly crosses a HITL boundary — verify with the hitl-approval-gate skill.'],
    [/kill.?switch|halt/i,
      'Kill switch: must always work at merchant / agent-type / global scope. Do not add an unstoppable path.'],
  ];

  const hits = rules.filter(([re]) => re.test(path)).map(([, msg]) => msg);
  if (hits.length) {
    process.stderr.write(
      `\n[PalUp governance reminder] editing ${path}\n  - ${hits.join('\n  - ')}\n` +
      `  Run /governance-check before merge.\n`
    );
  }
  process.exit(0); // advisory; change to 2 to block
});
