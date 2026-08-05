import type { RuntimeStatePort } from "@palup/platform-ports";
import {
  armKill,
  createRuntimeStore,
  disarmKill,
  killStatus,
  RUNTIME_AGENT_TYPE,
  type KillEntry,
  type KillScope,
} from "@palup/state-postgres";
import { tenantsToSweep } from "./retention-sweep.js";

// The OPERATOR ENTRY POINT for governance non-negotiable #4 — "any agent, at any scope, can be halted
// instantly".
//
// WHAT THIS EXISTS FOR. The HONOR side of the kill switch was already complete: `matchedKill` is read on
// /chat, /consent, /forget, the customer-account routes and the scheduled retention sweep, over the SHARED
// RuntimeStatePort, so a halt propagates to every serving instance. The ARMING side was not. `armKill`'s
// only caller was `packages/control-plane/src/server.ts` — and this repo deploys only the widget backend
// (`deploy-staging.yml` deploys `palup-widget-staging`; the container entrypoint is `pnpm backend`). With
// the control plane undeployed, halting the LIVE agent meant hand-writing a row into Cloud SQL, documented
// in no runbook. NN #4 was satisfied in code and unreachable in practice. This closes that gap.
//
// WHY A CLI AND NOT A NEW HTTP ENDPOINT — the same argument retention-sweep.ts makes for the sweep, and it
// applies with more force here: widget-backend has NO admin authentication of any kind, so an admin route
// would have meant a new internet-reachable endpoint that halts the product, plus a new shared secret to
// guard it. A `pnpm kill:arm` run against the same `DATABASE_URL` needs neither, stays portable
// (ADR-0001) because it goes through the same `RuntimeStatePort` the server reads, and reuses `armKill` /
// `disarmKill` / `killStatus` verbatim — no second implementation of the registry that could drift from
// the one the serving path honors. The control-plane routes remain the operator-console path for when that
// plane IS deployed; this is the path that works today.
//
// AUTHORIZATION is the DATABASE_URL credential itself: whoever can reach the run-time state store can
// already halt the platform by hand, so this adds no new privilege — it makes the safe, audited, reversible
// form of that power available instead of hand-written SQL. The audit actor stays `"operator"` (armKill's
// contract), so `--reason` is where the human names themselves; the runbook says so.
//
// SAFETY PROPERTIES, each covered by a test in test/kill-switch-job.test.ts:
//  - NO IMPLICIT SCOPE. An absent, empty, or unparseable `--scope` is REFUSED. It never falls back to
//    `global` (the control-plane's HTTP route does `scope ?? "global"`; a forgotten flag on a CLI would
//    halt every merchant on the platform). Widening to every scope on disarm needs an explicit
//    `--scope all`, and `arm --scope all` does not exist.
//  - NEVER A SILENT NO-OP. Every action READS THE REGISTRY BACK and asserts the intended end state, so
//    "armed" is a confirmed observation, not an assumption. An unknown `agent:<type>` is refused (it
//    would halt nothing), and a `tenant:<id>` this deployment does not appear to serve is flagged.
//  - IT REFUSES A STORE NOBODY ELSE CAN SEE. Without `DATABASE_URL`, `createRuntimeStore()` returns a
//    PER-PROCESS in-memory store: the operator would see "armed" while the deployed backend — a different
//    process, a different store — kept serving shoppers. That is the exact failure this PR removes, so
//    this tool hard-fails instead of falling back.
//  - EVERY ACTION IS AUDITED ATOMICALLY WITH THE WRITE (NN #5), because `armKill`/`disarmKill` do it
//    inside one transaction. Nothing here writes the registry by any other route.
//  - IT REPORTS ITS OWN LATENCY. "Instant" is a measured claim: each run prints the elapsed ms from the
//    decision to the confirmed halt, so a drill produces evidence instead of an estimate.

export type KillAction = "arm" | "status" | "disarm";

export interface KillCommand {
  action: KillAction;
  /** Required for arm and disarm. Absent + `all` unset is always an error — never an implicit `global`. */
  scope?: KillScope;
  /** Set ONLY by an explicit `disarm --scope all`: lift every armed scope. */
  all?: boolean;
  /** Free text recorded in the audit row. Name yourself here — the audit actor is always "operator". */
  reason?: string;
}

/** Bad operator input (unknown subcommand, missing/unparseable scope). Distinct from a store failure so
 * `main` can print usage for one and a stack-free error for the other. */
export class KillArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KillArgsError";
  }
}

export interface KillSwitchReport {
  action: KillAction;
  /** The scope acted on; `"all"` for `disarm --scope all`, `undefined` for status. */
  target?: string;
  /** Registry state READ BACK after the action — the evidence, not the intent. */
  armed: KillEntry[];
  /** True when the read-back matches the intended end state. `runKillSwitch` throws rather than
   * returning false, so a caller holding a report can trust it. */
  confirmed: boolean;
  /** Decision → confirmed-halt latency, measured across the write and the read-back. */
  elapsedMs: number;
  /** Non-fatal operator warnings (e.g. a tenant this deployment does not appear to serve). */
  warnings: string[];
}

export const KILL_USAGE = [
  "usage:",
  '  pnpm kill:arm     --scope <global|tenant:ID|agent:TYPE> [--reason "why (your name)"]',
  "  pnpm kill:status",
  "  pnpm kill:disarm  --scope <global|tenant:ID|agent:TYPE|all>",
  "",
  "DATABASE_URL must point at the SAME run-time state store the deployed backend uses,",
  "otherwise the halt cannot reach it. There is no default scope, by design.",
].join("\n");

/**
 * Validate one operator-supplied scope string. Accepts exactly the three governed shapes, case-exact.
 *
 * The id/type is checked for being present and whitespace-free but NOT against a charset allow-list: the
 * registry is a KV keyed by this literal string, and an emergency halt must not be refused because this
 * tool has an opinion about a legitimate tenant id it has never seen. Semantic checks that CAN be made
 * safely (an `agent:<type>` that matches no running agent, a `tenant:<id>` this deployment does not serve)
 * happen in `runKillSwitch`, where the store and env are in hand.
 */
export function parseKillScope(raw: string): KillScope {
  if (raw === "global") return "global";
  const m = /^(tenant|agent):(.*)$/.exec(raw);
  if (!m) {
    throw new KillArgsError(`unparseable --scope "${raw}" — expected global, tenant:<id>, or agent:<type>`);
  }
  const [, kind, id] = m;
  if (!id || /\s/.test(id) || id.length > 128) {
    throw new KillArgsError(`--scope "${raw}" has no usable ${kind === "tenant" ? "tenant id" : "agent type"}`);
  }
  return `${kind as "tenant" | "agent"}:${id}` as KillScope;
}

/** Split `--flag=value` into its parts; a bare `--flag` yields no value. */
function splitFlag(arg: string): { flag: string; inline?: string } {
  const eq = arg.indexOf("=");
  return eq === -1 ? { flag: arg } : { flag: arg.slice(0, eq), inline: arg.slice(eq + 1) };
}

/**
 * Parse `[arm|status|disarm] [--scope X] [--reason Y]` (the args after the script path). Throws
 * `KillArgsError` on anything ambiguous — including an unrecognized flag, so a mistyped `--scop=global`
 * can never be silently dropped and leave the action running against a different scope than intended.
 */
export function parseKillArgv(argv: string[]): KillCommand {
  const [action, ...rest] = argv;
  if (action !== "arm" && action !== "status" && action !== "disarm") {
    throw new KillArgsError(
      action ? `unknown subcommand "${action}" — expected arm, status, or disarm` : "no subcommand — expected arm, status, or disarm",
    );
  }

  let rawScope: string | undefined;
  let reason: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const { flag, inline } = splitFlag(rest[i]!);
    if (flag !== "--scope" && flag !== "--reason") throw new KillArgsError(`unknown argument "${rest[i]}"`);
    // A value taken from the next argv slot must not itself be a flag: `--scope --reason x` is a forgotten
    // value, not a scope named "--reason".
    let value = inline;
    if (value === undefined) {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) throw new KillArgsError(`${flag} requires a value`);
      value = next;
      i++;
    }
    if (value === "") throw new KillArgsError(`${flag} requires a value`);
    if (flag === "--scope") rawScope = value;
    else reason = value;
  }

  if (action === "status") {
    if (rawScope !== undefined) throw new KillArgsError("status takes no --scope (it reports every armed scope)");
    if (reason !== undefined) throw new KillArgsError("status takes no --reason (it changes nothing)");
    return { action };
  }

  if (rawScope === undefined) {
    throw new KillArgsError(
      `${action} requires --scope <global|tenant:ID|agent:TYPE${action === "disarm" ? "|all" : ""}> — there is no default scope`,
    );
  }
  if (rawScope === "all") {
    // Deliberately asymmetric: lifting every halt is a recovery action an operator may genuinely want in
    // one command; arming every scope at once is not a thing, and `global` already says it precisely.
    if (action === "arm") throw new KillArgsError('--scope all is not armable — use --scope global to halt everything');
    return { action, all: true, ...(reason === undefined ? {} : { reason }) };
  }
  return { action, scope: parseKillScope(rawScope), ...(reason === undefined ? {} : { reason }) };
}

export interface KillSwitchDeps {
  store: RuntimeStatePort;
  /** Only used to sanity-check a `tenant:` scope against the tenants this deployment serves. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Perform one operator action and CONFIRM it against the registry. Throws (never returns an unconfirmed
 * report) when the intended end state is not observable afterwards, so no caller can report a halt that
 * did not happen.
 */
export async function runKillSwitch(deps: KillSwitchDeps, cmd: KillCommand): Promise<KillSwitchReport> {
  const warnings: string[] = [];

  // The scope guard is here as well as in the parser, so a future programmatic caller cannot arm an
  // implicit `global` by passing a command object with no scope.
  if (cmd.action !== "status" && !cmd.scope && !cmd.all) {
    throw new KillArgsError(`${cmd.action} requires an explicit scope — refusing to act on an unspecified scope`);
  }

  if (cmd.action === "arm" && cmd.scope) {
    // A kill armed for an agent type nothing runs under halts NOTHING while reading as "armed" — the
    // silent no-op NN #4 cannot tolerate. `RUNTIME_AGENT_TYPE` is the single source of truth the serving
    // path and the promotion path both check, so an unknown type is an operator typo. Widen this the same
    // day a second run-time agent type ships.
    const agent = /^agent:(.+)$/.exec(cmd.scope)?.[1];
    if (agent !== undefined && agent !== RUNTIME_AGENT_TYPE) {
      throw new KillArgsError(
        `no run-time agent type "${agent}" — the only agent type serving today is "${RUNTIME_AGENT_TYPE}", ` +
          `so this kill would halt nothing (use agent:${RUNTIME_AGENT_TYPE}, or tenant:<id>/global)`,
      );
    }
    // A tenant this deployment does not appear to serve is suspicious but NOT refusable: the tenant list
    // is env config, and a halt must never be blocked because config here is incomplete. Flagged loudly.
    const tenant = /^tenant:(.+)$/.exec(cmd.scope)?.[1];
    if (tenant !== undefined) {
      const known = tenantsToSweep(deps.env ?? process.env);
      if (known.length > 0 && !known.includes(tenant)) {
        warnings.push(
          `tenant "${tenant}" is not in this deployment's configured tenants (${known.join(", ")}) — ` +
            `armed anyway, but check the id: a kill on the wrong tenant halts nobody`,
        );
      }
    }
  }

  const started = Date.now();
  if (cmd.action === "arm") await armKill(deps.store, cmd.scope!, cmd.reason ?? "operator-cli");
  else if (cmd.action === "disarm") await disarmKill(deps.store, cmd.scope);

  // THE CONFIRMATION. Read the registry the serving path reads, and assert the end state.
  const armed = await killStatus(deps.store);
  const elapsedMs = Date.now() - started;
  const scopes = new Set(armed.map((e) => e.scope));

  if (cmd.action === "arm" && !scopes.has(cmd.scope!)) {
    throw new Error(
      `kill "${cmd.scope}" is NOT armed after the write — the halt is unconfirmed. Do not treat the agent ` +
        `as stopped; check DATABASE_URL points at the store the backend reads, then retry.`,
    );
  }
  if (cmd.action === "disarm") {
    const stillArmed = cmd.all ? armed.length > 0 : scopes.has(cmd.scope!);
    if (stillArmed) throw new Error(`disarm of "${cmd.all ? "all" : cmd.scope}" did not take effect — still armed`);
  }

  return {
    action: cmd.action,
    ...(cmd.action === "status" ? {} : { target: cmd.all ? "all" : cmd.scope }),
    armed,
    confirmed: true,
    elapsedMs,
    warnings,
  };
}

/**
 * The store this tool is allowed to operate on: the SHARED, durable one. `createRuntimeStore()` falls back
 * to a per-process in-memory store when `DATABASE_URL` is unset — a fine dev default for the server, and
 * the single worst outcome for this tool (an operator sees "armed"; the deployed backend never learns).
 *
 * `env` is the guard's input only; `createRuntimeStore()` itself reads `process.env` (one source of truth
 * for the connection string), so passing a synthetic env cannot redirect which store is opened.
 */
export async function resolveKillStore(env: NodeJS.ProcessEnv = process.env): Promise<{ store: RuntimeStatePort; kind: string }> {
  if (!env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is unset — refusing to run. Without it this process gets its OWN in-memory store, so " +
        "an 'armed' kill would never reach the deployed backend (NN #4: the kill switch must halt every " +
        "serving instance). Point DATABASE_URL at the same Cloud SQL instance the backend uses.",
    );
  }
  const { store, kind } = await createRuntimeStore();
  return { store, kind };
}

async function main(): Promise<void> {
  let cmd: KillCommand;
  try {
    cmd = parseKillArgv(process.argv.slice(2));
  } catch (e) {
    console.error(`[kill] ${(e as Error).message}\n\n${KILL_USAGE}`);
    return exit(2);
  }

  try {
    const { store, kind } = await resolveKillStore();
    const report = await runKillSwitch({ store }, cmd);
    for (const w of report.warnings) console.error(`[kill] WARNING: ${w}`);

    if (report.action === "status") {
      console.log(`[kill] store=${kind} armed=${report.armed.length}`);
      for (const e of report.armed) console.log(`[kill]   ${e.scope}  reason="${e.reason}"  at=${e.at}`);
      if (report.armed.length === 0) console.log("[kill]   (nothing armed — the agent is serving)");
    } else {
      // The operator-visible confirmation. `elapsedMs` is measured across the write AND the read-back, so
      // it is the real decision→halt-confirmed latency, not a write ack (see the drill in the PR body).
      const verb = report.action === "arm" ? "HALTED" : "RESUMED";
      console.log(`[kill] ${verb}: ${report.action} ${report.target} — CONFIRMED in ${report.elapsedMs}ms (store=${kind})`);
      console.log(`[kill] armed now: ${report.armed.length === 0 ? "(none)" : report.armed.map((e) => e.scope).join(", ")}`);
      if (report.action === "arm") console.log("[kill] reverse with: pnpm kill:disarm --scope " + report.target);
    }
    return exit(0);
  } catch (e) {
    // Message only, no stack: an operator mid-incident needs the sentence, and the message is PII-free.
    console.error(`[kill] FAILED: ${(e as Error).message}`);
    console.error("[kill] the agent's state is UNCHANGED by a failed run — verify with: pnpm kill:status");
    return exit(1);
  }
}

/** Flush stdout, then exit. `createRuntimeStore` opens a `pg.Pool` with no close hook, which would keep
 * this process alive for the pool's idle timeout — an emergency tool must not look hung after it has
 * already confirmed the halt. Safe because everything reported is committed and re-read before we get
 * here. (The scheduled sweep can afford to linger; this cannot.) */
function exit(code: number): Promise<never> {
  return new Promise<never>((resolve) => {
    process.stdout.write("", () => {
      process.exit(code);
      resolve(undefined as never);
    });
  });
}

// Run only when invoked directly (`pnpm kill:arm` etc.), never on import — the test imports this module.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
