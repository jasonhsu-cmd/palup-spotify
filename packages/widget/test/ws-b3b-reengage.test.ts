import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// WS-B3b — client dwell/hesitation/idle_then_return detectors + the proactive "reengage" nudge.
//
// index.html's panel logic is a plain inline <script> (not an ES module — see loader-core.ts for the one
// piece of widget/ that IS a module and gets a real jsdom execution test in loader-core.test.ts). There is
// no execution harness for this inline script: exercising it would mean faking fetch/sessionStorage/timers
// against every DOM id it queries (#widget, #launcher, #f, #in, #mood, #cart, ...), which is out of scope
// for this task. Source-level pinning is the EXISTING convention this file's neighbors already use for
// this exact file (carryover-copy.test.ts, f10-erasure-honesty.test.ts) — this test follows the same
// pattern. GAP (reported, not silently accepted): no test here actually FIRES a fake timer and asserts
// sendProactive was called; a future jsdom execution harness for index.html's inline script would close it.

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../public/index.html"), "utf8");

describe("WS-B3b — reengage has its own once-per-session cap, separate from exit-intent's", () => {
  it("defines REENGAGE_KEY distinct from EXIT_KEY", () => {
    expect(html).toContain('const EXIT_KEY = "palup.widget.exitintent.v1"');
    expect(html).toContain('const REENGAGE_KEY = "palup.widget.reengage.v1"');
  });

  it("reads/writes REENGAGE_KEY through its own helpers, never touching EXIT_KEY", () => {
    expect(html).toContain("function reengageFired()");
    expect(html).toContain("function markReengageFired()");
    expect(html).toMatch(/function reengageFired\(\)\{[^}]*REENGAGE_KEY/);
    expect(html).toMatch(/function markReengageFired\(\)\{[^}]*REENGAGE_KEY/);
  });

  it("fireReengage marks the cap BEFORE calling sendProactive, and only ever passes 'reengage'", () => {
    const m = html.match(/function fireReengage\(evt\)\{([\s\S]*?)\n  \}/);
    expect(m, "fireReengage not found").toBeTruthy();
    const body = m![1];
    const markIdx = body.indexOf("markReengageFired()");
    const sendIdx = body.indexOf("sendProactive(");
    expect(markIdx).toBeGreaterThan(-1);
    expect(sendIdx).toBeGreaterThan(-1);
    expect(markIdx).toBeLessThan(sendIdx); // mark-before-send, so it can never double-fire
    expect(body).toContain('sendProactive("reengage")');
  });
});

describe("WS-B3b — dwell fires reengage only while the panel is open, after ~8s of no interaction", () => {
  it("guards on widget.hidden and reengageFired() before arming the timer", () => {
    expect(html).toContain("const DWELL_MS = 8000");
    expect(html).toMatch(/function scheduleDwell\(\)\{[\s\S]*?if \(reengageFired\(\) \|\| widget\.hidden\) return;/);
  });

  it("resets on interaction (click/keydown/scroll/mousemove), not just elapsed time", () => {
    expect(html).toMatch(
      /\["click", "keydown", "scroll", "mousemove"\]\.forEach\(\(evt\) => widget\.addEventListener\(evt, scheduleDwell/,
    );
  });

  it("pushes 'dwell' via fireReengage on timeout", () => {
    expect(html).toMatch(/setTimeout\(\(\) => \{ if \(!widget\.hidden\) fireReengage\("dwell"\); \}, DWELL_MS\)/);
  });
});

describe("WS-B3b — idle_then_return fires reengage on refocus after ~30s idle", () => {
  it("defines a 30s idle window and only fires if idle was actually reached", () => {
    expect(html).toContain("const DWELL_MS = 8000, IDLE_MS = 30000, HESITATE_PAUSE_MS = 5000");
    expect(html).toMatch(/function onReturn\(\)\{ if \(wentIdle\) fireReengage\("idle_then_return"\); scheduleIdle\(\); \}/);
  });

  it("listens for visibilitychange→visible and window focus", () => {
    expect(html).toMatch(/document\.visibilityState === "visible"\) onReturn\(\)/);
    expect(html).toContain('window.addEventListener("focus", onReturn)');
  });
});

describe("WS-B3b — hesitation is behavioral-array-only; it never calls sendProactive", () => {
  it("detects grow-then-shrink and a mid-compose pause on the #in compose input", () => {
    expect(html).toContain('const composeEl = $("#in")');
    expect(html).toMatch(/if \(len < lastLen && grew\)\{ pushBehavioral\("hesitation"\); grew = false; \}/);
    expect(html).toMatch(/pauseTimer = setTimeout\(\(\) => pushBehavioral\("hesitation"\), HESITATE_PAUSE_MS\)/);
  });

  it("the hesitation IIFE body contains no sendProactive call", () => {
    const start = html.indexOf("(function(){\n    const composeEl = $(\"#in\");");
    const end = html.indexOf("})();", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const hesitationBlock = html.slice(start, end);
    expect(hesitationBlock).not.toContain("sendProactive");
    expect(hesitationBlock).toContain("pushBehavioral");
  });
});

describe("WS-B3b — the accumulated behavioral array rides on the shopper's own next send(), then clears", () => {
  it("send() spreads behavioralEvents into signals and clears the array right after", () => {
    expect(html).toMatch(
      /\.\.\.\(behavioralEvents\.length \? \{ behavioral: behavioralEvents\.slice\(\) \} : \{\}\),\s*\n\s*\};\s*\n\s*behavioralEvents = \[\];/,
    );
  });

  it("pushBehavioral de-duplicates (an event is never pushed twice into the same array)", () => {
    expect(html).toMatch(/function pushBehavioral\(evt\)\{ if \(behavioralEvents\.indexOf\(evt\) === -1\) behavioralEvents\.push\(evt\); \}/);
  });
});
