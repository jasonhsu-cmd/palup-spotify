import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE SHOPPER-PROMISE GUARD — a shopper must never be told about a capability this system does not
// have. This is NOT a snapshot of today's strings (a snapshot goes green the moment someone edits the
// snapshot). It is keyed on the CLASS OF CLAIM: text that asserts a live human is joining, that a
// human is currently working the issue, that data has been deleted/exported, that nothing is stored,
// or that something is guaranteed/permanent. Any new string in that class fails this test until its
// author either wires the capability or rewords the text.
//
// WHY THIS EXISTS (the defect it locks, verified by reading the code, 2026-08-05):
//   • `signals.handoff` — the ONLY input that means "a human took over" (widget-brain/src/types.ts:184,
//     consumed at widget-brain/src/session.ts:306) — has NO PRODUCTION PRODUCER.
//     `deriveServingSignals` (widget-backend/src/signals.ts:62-129) never accepts it from the client and
//     no route sets it; the only writers in the whole repo are tests. So no human has ever joined a
//     widget conversation, and none can: there is no live-agent channel at all (`CommsPort`'s
//     take-over surface — packages/platform-ports/src/comms-port.ts — has no production consumer either;
//     grep: only its own port test).
//   • What escalation DOES do is real but much smaller: `escalateToHuman` sets a flag that becomes an
//     immutable audit row (widget-backend/src/audit.ts `actionFor`/`buildAuditInput`) plus a traffic-log
//     entry. Nothing pushes that row to a person, and no console reads it (searched control-plane's
//     routes: `/api/state` exposes the EVOLUTION engine's audit, never the RuntimeStatePort log).
//   So "I've flagged this for a person" is TRUE and "a person is joining this chat" is FALSE, and the
//   widget said the second one for the whole of its life.
//
// WHERE THIS GUARD LOOKS, AND WHY THAT COVERS THE SHOPPER-VISIBLE SURFACE
//   1. `packages/widget/public/index.html` — the entire widget UI. widget-backend serves this file
//      verbatim (`widgetHtml`, server.ts:185), so every literal in it can reach a shopper's screen.
//   2. EVERY `.ts` under `packages/widget-brain/src` — the brain returns `Decision.reply`, which the
//      widget renders verbatim (`add(d.reply, "agent", d)`, index.html:683).
//   3. EVERY `.ts` under `packages/widget-backend/src` — the composition root: it owns the /chat
//      response the widget renders and the OAuth callback page (`caaCallbackHtml`, server.ts:201).
//   Globs, not file lists: you cannot dodge this guard by putting the string in a NEW file in those
//   packages. Moving shopper copy OUT of those packages entirely would mean moving it out of the only
//   code paths that can render it to a shopper.
//
// WHAT IT STRUCTURALLY CANNOT COVER (stated so nobody mistakes green for proof):
//   • MODEL-GENERATED text. On the clean sales/support path the reply is the LLM's own words
//     (brain.ts's `model.complete`), and no grep can constrain a token stream. That surface is governed
//     by the system-prompt rules (brain.ts `groundedMessages`) and the eval corpus, not by this test.
//   • Merchant-authored catalog/policy text, which arrives as grounding data at runtime.
//   • Text assembled from variables at runtime, e.g. `"a " + noun + " is joining"`.
//   • A determined author can still register a false mechanism below. The mechanism check makes that an
//     explicit, reviewable lie instead of an accident.
//
// A BOUNDARY THIS GUARD DELIBERATELY DOES NOT POLICE, and why: the agent's OFFERS to escalate ("I can
// bring in a person", "Want me to connect you with someone?") and its "I've flagged / handed this to
// the team" phrasings stay allowed. Those describe the record that genuinely exists — the escalate flag
// and its audit row — and whether a merchant's staff ever act on it depends on an operator process that
// lives outside this repo, so this repo cannot prove them false. What it CAN prove false is a live join,
// a human known to be working right now, an export, a storage denial, and a completed erasure. Those are
// the classes above.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const rel = (abs: string): string => relative(REPO, abs).split(sep).join(posix.sep);

export function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".ts")) out.push(p);
    }
  };
  walk(join(REPO, dir));
  return out.sort();
}

/** Every file whose text can reach a shopper's screen. See the header for why this list is complete. */
const SURFACES: string[] = [
  join(REPO, "packages/widget/public/index.html"),
  ...tsFilesUnder("packages/widget-brain/src"),
  ...tsFilesUnder("packages/widget-backend/src"),
];

// ── Comment stripping ────────────────────────────────────────────────────────────────────────────
// Comments are NOT shopper-visible, and this file's own subject matter has to be discussable in prose
// next to the code (widget-backend/src/server.ts quotes a UI string inside a comment, for example). So
// comments are blanked — replaced space-for-space, newlines preserved, so reported line numbers still
// match the real file.
//
// The scanner tracks string and regex literals so that blanking never eats real text: `/don'?t/` must
// not be mistaken for the start of a string, and `"https://x"` must not be mistaken for a comment. It
// errs toward KEEPING text (a mis-detected comment stays and can only cause a loud false positive),
// never toward hiding it.
const REGEX_MAY_FOLLOW = new Set("([{,;:=!&|?+-*%~^<>".split(""));
const REGEX_MAY_FOLLOW_WORDS = new Set([
  "return",
  "typeof",
  "case",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "instanceof",
  "do",
  "else",
  "yield",
  "await",
]);

export function stripComments(src: string): string {
  const out: string[] = [];
  const blank = (s: string): void => out.push(s.replace(/[^\n]/g, " "));
  let i = 0;
  let prevSig = ""; // last significant (non-space) char seen in code position
  let prevWord = "";
  const n = src.length;
  while (i < n) {
    const c = src[i] as string;
    const c2 = src[i + 1];
    if (c === "<" && src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      const stop = end === -1 ? n : end + 3;
      blank(src.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === "/" && c2 === "/") {
      let end = src.indexOf("\n", i);
      if (end === -1) end = n;
      blank(src.slice(i, end));
      i = end;
      continue;
    }
    if (c === "/" && c2 === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(src.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n) {
        const d = src[j] as string;
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === c) break;
        // An unterminated single/double-quoted literal (an apostrophe in HTML prose, say) must not
        // swallow the rest of the file: stop at the newline, exactly like a real JS string would.
        if (d === "\n" && c !== "`") break;
        j++;
      }
      out.push(src.slice(i, Math.min(j + 1, n)));
      prevSig = c;
      prevWord = "";
      i = j + 1;
      continue;
    }
    if (c === "/") {
      const isRegex = prevSig === "" || REGEX_MAY_FOLLOW.has(prevSig) || REGEX_MAY_FOLLOW_WORDS.has(prevWord);
      if (isRegex) {
        let j = i + 1;
        let inClass = false;
        while (j < n) {
          const d = src[j] as string;
          if (d === "\\") {
            j += 2;
            continue;
          }
          if (d === "[") inClass = true;
          else if (d === "]") inClass = false;
          else if (d === "/" && !inClass) break;
          else if (d === "\n") break; // not a regex after all — bail out rather than eat the file
          j++;
        }
        out.push(src.slice(i, Math.min(j + 1, n)));
        prevSig = "/";
        prevWord = "";
        i = j + 1;
        continue;
      }
    }
    out.push(c);
    if (!/\s/.test(c)) {
      prevSig = c;
      prevWord = /[A-Za-z]/.test(c) ? prevWord + c : "";
    }
    i++;
  }
  return out.join("");
}

// ── The claim classes ────────────────────────────────────────────────────────────────────────────
// `capability` = what the text tells the shopper the system can do.
// `absent` = the verified reason it cannot, with the file evidence.
// `remedy` = what the author of a NEW match should do. The failure message prints all three.
export interface ClaimClass {
  id: string;
  capability: string;
  absent: string;
  remedy: string;
  patterns: RegExp[];
}

const CLAIM_CLASSES: ClaimClass[] = [
  {
    id: "live-human-joins-this-chat",
    capability: "a human being will appear in THIS chat and continue it",
    absent:
      "there is no live-agent channel. `signals.handoff` (widget-brain/src/types.ts) has no production " +
      "producer — widget-backend/src/signals.ts never accepts it and no route sets it — and CommsPort's " +
      "take-over surface has no production consumer.",
    remedy:
      "wire a real two-way handoff (a producer for `signals.handoff` + the channel behind it) and register " +
      "the string with that mechanism, or reword to what escalation actually does: it FLAGS the " +
      'conversation for a person (e.g. "I\'ve flagged this for a person").',
    patterns: [
      /\bjoining (this|the) (chat|conversation)\b/i,
      /\b(person|human|team ?member|specialist|agent|advisor|representative|colleague|someone)\b[^.!?\n]{0,25}\b(is|'s|are|will be) (joining|jumping in|stepping in|taking over)\b/i,
      /\b(I'?m|I am|we'?re|we are) (now )?(connecting|transferring|putting) you\b/i,
      /\b(I'?ve|I have) connected you\b/i,
      /\b(I'?m|I am) (handing|passing) you (to|over)\b/i,
      /\b(I'?m|I am) bringing in\b/i,
    ],
  },
  {
    id: "human-is-working-on-it-right-now",
    capability: "a named human is, as a matter of fact, working this shopper's issue at this moment",
    absent:
      "nothing delivers an escalation to a person. An escalating turn writes an audit row " +
      "(widget-backend/src/audit.ts) and a traffic-log line; no queue, notification, ticket or console " +
      "reads either, so the agent cannot know that anyone is engaged.",
    remedy:
      'state the record that exists instead of the person who may not (e.g. "this is still flagged for ' +
      'our team"), or build the delivery mechanism and register the string with it.',
    patterns: [
      /\b(a member of our team|our team|someone|a person|a specialist)\b[^.!?\n]{0,30}\bis (still )?(looking into|working on|reviewing|handling)\b/i,
      /\b(our team|a member of our team) is on\b/i,
    ],
  },
  {
    id: "conversation-handed-to-a-human",
    capability: "the transcript is retained and delivered to the human who takes over",
    absent:
      "no human takes over (see live-human-joins-this-chat), and no transcript is kept for one: the " +
      "server persists CONTROL state only (widget-brain/src/session.ts — 'no shopper transcript " +
      "persisted') and the client's copy is per-tab sessionStorage (index.html).",
    remedy: "drop the claim, or register it once a handoff mechanism actually carries the transcript.",
    patterns: [
      /\b(they'?ll|they will|a person will|the team will|someone will) (see|read|have) (the|your|this|all) [^.!?\n]{0,20}(conversation|chat|thread|messages|history)\b/i,
      /\byour messages are saved\b/i,
    ],
  },
  {
    id: "data-export",
    capability: "the shopper can be sent a copy/export of their data (GDPR Art. 15 / CCPA access)",
    absent:
      "no export path exists anywhere in packages/ — searched every .ts for an export/portability/subject-" +
      "access route or port method; the only hit was the promise itself.",
    remedy: "build the export (a route + a port method) and register the string with it, or remove the offer.",
    patterns: [
      /\b(a |an )?copy of (your|their) (data|information|details|records)\b/i,
      /\bexport (your|their) (data|information)\b/i,
      /\bsend you (a copy of )?(your|the) (data|information)\b/i,
    ],
  },
  {
    id: "storage-denial",
    capability: "the system holds nothing about the shopper",
    absent:
      "it holds several things: the per-tenant traffic log keeps the (card/SSN-redacted) message AND reply " +
      "text (widget-backend/src/canary.ts `logTraffic`), session control state is durable, and when memory " +
      "is enabled the vector store keeps distilled facts. `POST /forget` erases only the vector namespace " +
      "(widget-memory/src/erasure.ts `eraseSubject`).",
    remedy:
      "say what IS kept and for how long, or — for a genuinely narrow denial about one specific field — " +
      "register it with the code that guarantees it.",
    patterns: [
      /\b(we|I) (don'?t|do not|never) (store|keep|save|retain|record)\b/i,
      /\bnothing is (stored|saved|kept|retained|recorded)\b/i,
      /\bno (data|information) is (stored|saved|kept|retained)\b/i,
    ],
  },
  {
    id: "absolute-or-instant-erasure",
    capability: "an erasure is total, irreversible and/or instant",
    absent:
      "`eraseSubject` deletes ONE vector namespace. It does not touch the traffic log (no anonId->sessionId " +
      "link exists to key it by), the consent record, or anything on the merchant's own platform; " +
      "`eraseTenant` throws NotImplemented (widget-memory/src/erasure.ts).",
    remedy: "scope the claim to what is actually deleted, or register it with the code that makes it total.",
    patterns: [
      /\bpermanently (deleted|erased|removed|wiped)\b/i,
      /\b(deleted|erased|removed|gone) (forever|for good|from everywhere)\b/i,
      /\bwiped from (our|the) (systems?|servers?|records?|databases?)\b/i,
      /\ball (of )?(your|their) (data|information) (has been|is|was) (deleted|erased|removed)\b/i,
      /\b(instantly|immediately) (deleted|erased|removed|refunded)\b/i,
    ],
  },
  {
    id: "unqualified-guarantee",
    capability: "an outcome is guaranteed / absolute",
    absent:
      "nothing in this system guarantees a shopper outcome: safety answers are grounded in a catalog that " +
      "may be incomplete, money actions above the ceiling are routed to a human who may never see them, " +
      "and every escalation is a flag rather than a delivery.",
    remedy: 'qualify the claim honestly (the code already prefers "I can\'t guarantee …"), or register the mechanism.',
    patterns: [/\bguarantee(d|s)?\b/i, /\b100% (safe|secure|private|certain|deleted|erased)\b/i],
  },
  {
    id: "completed-action",
    capability: "an action the shopper asked for is DONE",
    absent:
      "most shopper-visible actions in this phase are routed, not executed — the agent has no execution " +
      "path for refunds, cancellations, address changes or a live handoff.",
    remedy:
      "only claim completion where the code awaited a real result and checked it (as the subscription " +
      "self-serve path does with `result.ok`), and register that mechanism.",
    patterns: [
      /\bDone\s*[—-]\s*I'?ve\b/i,
      /\bI'?ve (deleted|erased|cleared|wiped|purged|recorded|logged)\b/i,
      /\bI'?ve (skipped|paused|resumed|cancelled|canceled|refunded) (your|the|this)\b/i,
      // Pillar 2a (in-chat checkout) — POST /cart/checkout-url only ever hands back a checkout LINK
      // (cart-permalink-adapter.ts is a pure string builder: no fetch, no Shopify SDK, no add-to-cart
      // I/O, no purchase). Before these two patterns, this claim class had zero cart/checkout coverage —
      // a false "I've added/bought/purchased" would have shipped undetected.
      /\bI'?ve (added|checked out|bought|purchased)\b/i,
      /\badded (it|them|that) to (your|the) (cart|bag|basket|checkout)\b/i,
    ],
  },
];

// A claim that is DENIED is not a promise. "I can't guarantee a product is safe" is the honest form the
// code already uses, so a negation in the ~64 characters before the match exempts it. Known limit:
// "I'm not going to keep you waiting — a person is joining now" would slip through this window; the
// mechanism registry, not the negation window, is the backstop for anything subtle.
const NEGATION = /\b(can'?t|cannot|won'?t|will not|never|not|no|don'?t|do not|isn'?t|aren'?t|unable|without)\b/i;

// ── The mechanism registry — the ONLY way a matched claim is allowed to stay ──────────────────────
// Each entry must name the code that makes the claim true. `symbol` is checked to exist, OUTSIDE
// COMMENTS, in `mechanismFile` — so an entry cannot be satisfied by a comment that merely describes an
// intention, and a mechanism that is later deleted turns this test red rather than leaving a live lie.
export interface AllowedClaim {
  /** A distinctive fragment of the shopper-visible sentence, as it appears in the source. */
  claim: string;
  /** The surface file the claim is allowed to appear in (repo-relative, posix). */
  surface: string;
  symbol: string;
  mechanismFile: string;
  why: string;
}

export const ALLOWED_CLAIMS: AllowedClaim[] = [
  {
    claim: "Done — I've skipped your next delivery",
    surface: "packages/widget-brain/src/support.ts",
    symbol: "skipNextDelivery",
    mechanismFile: "packages/platform-ports/src/commerce-port.ts",
    why: "support.ts awaits commerce.skipNextDelivery and only says 'Done' when result.ok; the reversal path is audited.",
  },
  {
    claim: "Done — I've paused your subscription",
    surface: "packages/widget-brain/src/support.ts",
    symbol: "pauseSubscription",
    mechanismFile: "packages/platform-ports/src/commerce-port.ts",
    why: "same shape as the skip: real port call, result.ok checked, reversal audited.",
  },
  {
    claim: "Done — I've resumed your subscription",
    surface: "packages/widget-brain/src/support.ts",
    symbol: "resumeSubscription",
    mechanismFile: "packages/platform-ports/src/commerce-port.ts",
    why: "same shape as the skip: real port call, result.ok checked, reversal audited.",
  },
  {
    claim: "Done — I've put your next delivery back on schedule",
    surface: "packages/widget-brain/src/support.ts",
    symbol: "unskipNextDelivery",
    mechanismFile: "packages/platform-ports/src/commerce-port.ts",
    why: "the executable reversal of a prior skip: real port call, result.ok checked.",
  },
  {
    claim: "Done — I've cleared what I remembered",
    surface: "packages/widget/public/index.html",
    symbol: "eraseSubject",
    mechanismFile: "packages/widget-memory/src/erasure.ts",
    why:
      "POST /forget calls eraseSubject (vector deleteNamespace + unconditional audit). The widget only " +
      "renders this line after the response is ok — see the r.ok branch in forgetMe(), and the E2E case " +
      "that pins a failed /forget to a different message.",
  },
  {
    claim: "I've recorded your request",
    surface: "packages/widget-brain/src/brain.ts",
    symbol: "data_rights.erasure_requested",
    mechanismFile: "packages/widget-backend/src/audit.ts",
    why:
      "the DSAR turn's flags make it governance-relevant, so buildAuditInput writes an immutable audit row " +
      "under its own named action — 'recorded' claims exactly that row and nothing more.",
  },
];

// ── The scanner ──────────────────────────────────────────────────────────────────────────────────
export interface Violation {
  file: string;
  line: number;
  matched: string;
  klass: ClaimClass;
}

/** Every [start,end) range in `text` occupied by a registered claim for this surface. */
function allowedRanges(path: string, text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const a of ALLOWED_CLAIMS) {
    if (a.surface !== path) continue;
    let from = 0;
    for (;;) {
      const at = text.indexOf(a.claim, from);
      if (at === -1) break;
      ranges.push([at, at + a.claim.length]);
      from = at + 1;
    }
  }
  return ranges;
}

export function scan(files: Array<{ path: string; source: string }>): Violation[] {
  const violations: Violation[] = [];
  for (const { path, source } of files) {
    const text = stripComments(source);
    const allowed = allowedRanges(path, text);
    for (const klass of CLAIM_CLASSES) {
      for (const pattern of klass.patterns) {
        const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
        for (const m of text.matchAll(re)) {
          const at = m.index ?? 0;
          const end = at + m[0].length;
          const before = text.slice(Math.max(0, at - 64), at);
          if (NEGATION.test(before)) continue;
          // A registered claim exempts ONLY the span of that sentence — deliberately NOT the whole line.
          // Line-level exemption was the first version of this check and it was a hole: a shopper reply
          // is one long source line, so a single registered claim on it would have exempted every OTHER
          // claim in the same string (proven by the brain mutation test, which went green while the
          // spliced "permanently erased" sat on the same line as an allowed "I've recorded your request").
          if (allowed.some(([s, e]) => at >= s && end <= e)) continue;
          const line = text.slice(0, at).split("\n").length;
          violations.push({ file: path, line, matched: m[0], klass });
        }
      }
    }
  }
  return violations;
}

export function report(v: Violation): string {
  return [
    ``,
    `SHOPPER-VISIBLE OVER-PROMISE — ${v.file}:${v.line}`,
    `  matched text : "${v.matched}"`,
    `  claim class  : ${v.klass.id}`,
    `  this claims  : ${v.klass.capability}`,
    `  but          : ${v.klass.absent}`,
    `  so EITHER wire ${v.klass.id} and add the sentence to ALLOWED_CLAIMS naming the symbol + file that`,
    `  makes it true (this test checks that symbol really exists outside comments), OR reword the text:`,
    `  ${v.klass.remedy}`,
  ].join("\n");
}

export const SHOPPER_SURFACES = SURFACES.map((path) => ({ path: rel(path), source: readFileSync(path, "utf8") }));
