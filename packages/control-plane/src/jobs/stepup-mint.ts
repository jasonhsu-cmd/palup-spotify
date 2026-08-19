import { randomBytes } from "node:crypto";
import { mintStepUp, type StepUpClaims } from "@palup/platform-ports";
import { STEPUP_ACTION, PLATFORM_STEPUP_ACTION, PLATFORM_TENANT } from "@palup/state-postgres";

// Operator CLI to MINT a step-up assertion for the ADR-0014 prereq #6 auto-promote switches
// (`/api/autopromote/platform`, `/api/autopromote/optin` — `packages/control-plane/src/server.ts`).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS. `verifyStepUp` (`@palup/platform-ports/step-up.ts`) and the two routes it guards were
// built and tested, but there was no tool that MINTS the assertion an operator actually sends: a real
// step-up is signed with a SEPARATE elevated secret (`AUTOPROMOTE_STEPUP_SECRET`) the standing
// OPERATOR_TOKEN holder need not possess, is fresh (5-minute max age), is bound to an exact
// action+tenant, and is single-use — none of that is something an operator can hand-construct. Without a
// minter, the only "working" caller was the test suite. This closes that gap, mirroring
// `widget-backend/src/jobs/kill-switch.ts` / `cost-cap.ts`: an operator entry point for a control-plane
// primitive that already exists and is already governed, just previously unreachable by a human.
//
// SIGNS WITH THE SAME SECRET THE CONTROL PLANE VERIFIES WITH. `mintStepUpAssertion` below reads
// `process.env.AUTOPROMOTE_STEPUP_SECRET` and calls `mintStepUp` from that SAME secret constant the
// control plane's `/api/autopromote/*` routes pass to `verifyStepUp` (`server.ts`) — this tool mints
// nothing a differently-configured deployment could ever accept, and a deployment with the secret unset
// FAILS CLOSED here rather than minting a token nobody can verify.
//
// NOT A STANDING CREDENTIAL. This process never talks to the control plane or any store — it only signs
// a short-lived, single-use claim locally and prints it, so the operator can paste it into the request
// that actually performs the action (still gated by the standing `OPERATOR_TOKEN` bearer auth on top of
// this). Minting an assertion is not itself an autonomous or boundary-crossing action; USING it to flip
// `/api/autopromote/*` is what setAutoPromoteOptIn/setPlatformAutoPromote audit (NN #5), and both of
// those refuse a non-human actor regardless (`state-postgres/autopromote-optin.ts`).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type StepUpMintTarget = "platform" | "optin";

export interface StepUpMintCommand {
  target: StepUpMintTarget;
  /** `PLATFORM_TENANT` for "platform"; the merchant's own id for "optin". */
  tenantId: string;
}

export class StepUpMintArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepUpMintArgsError";
  }
}

export const STEPUP_MINT_USAGE = [
  "usage:",
  "  pnpm stepup:mint platform          mint a step-up for the PLATFORM master switch",
  "  pnpm stepup:mint optin <tenantId>  mint a step-up for one merchant's auto-promote opt-in",
  "",
  "AUTOPROMOTE_STEPUP_SECRET must be set to the SAME elevated secret the control plane verifies with —",
  "never the standing OPERATOR_TOKEN. The assertion is single-use and expires 5 minutes after minting",
  "(platform-ports/step-up.ts) — mint it immediately before the request that uses it.",
].join("\n");

/** Which `verifyStepUp` action a given target binds to — the SAME constants
 * `state-postgres/autopromote-optin.ts` and `control-plane/server.ts` use, never re-typed here. */
export function actionFor(target: StepUpMintTarget): string {
  return target === "platform" ? PLATFORM_STEPUP_ACTION : STEPUP_ACTION;
}

export function parseStepUpMintArgv(argv: string[]): StepUpMintCommand {
  const [target, tenantIdArg, ...rest] = argv;
  if (target !== "platform" && target !== "optin") {
    throw new StepUpMintArgsError(
      target ? `unknown target "${target}" — expected platform or optin` : "no target — expected platform or optin",
    );
  }
  if (target === "platform") {
    if (tenantIdArg !== undefined) throw new StepUpMintArgsError("platform takes no tenantId — it always binds to the platform tenant");
    return { target, tenantId: PLATFORM_TENANT };
  }
  if (!tenantIdArg || tenantIdArg.startsWith("--")) throw new StepUpMintArgsError("optin requires a <tenantId> argument");
  if (rest.length > 0) throw new StepUpMintArgsError(`unknown argument "${rest[0]}"`);
  return { target, tenantId: tenantIdArg };
}

export interface MintDeps {
  /** The elevated step-up secret. Sourced from `process.env.AUTOPROMOTE_STEPUP_SECRET` in `main`; passed
   * explicitly here so tests never depend on process env. */
  secret: string | undefined;
  now?: number;
  /** Overridable only for deterministic tests — `main` always generates a fresh random one. */
  nonce?: string;
}

/**
 * Mint the assertion. FAILS CLOSED with no secret: signing with an empty/placeholder value would produce
 * a token that looks valid but that no real deployment (which also requires the secret to be set —
 * `verifyStepUp`'s own `!secret` fail-closed check) could ever accept, and an operator seeing a printed
 * assertion but no accompanying warning could easily mistake that for success.
 */
export function mintStepUpAssertion(cmd: StepUpMintCommand, deps: MintDeps): string {
  if (!deps.secret) {
    throw new Error(
      "AUTOPROMOTE_STEPUP_SECRET is unset — refusing to mint. The control plane verifies with this exact " +
        "secret (server.ts passes it to verifyStepUp); minting without it would produce an assertion " +
        "nothing can ever accept.",
    );
  }
  const claims: StepUpClaims = {
    action: actionFor(cmd.target),
    tenantId: cmd.tenantId,
    iat: deps.now ?? Date.now(),
    // A FRESH, random nonce per mint — the caller (setAutoPromoteOptIn/setPlatformAutoPromote) records it
    // atomically with the action, so a captured/replayed assertion can be used at most once.
    nonce: deps.nonce ?? randomBytes(16).toString("hex"),
  };
  return mintStepUp(deps.secret, claims);
}

function curlFor(cmd: StepUpMintCommand, assertion: string): string {
  const route = cmd.target === "platform" ? "/api/autopromote/platform" : "/api/autopromote/optin";
  const body = cmd.target === "platform" ? { enabled: true } : { tenantId: cmd.tenantId, enabled: true };
  return (
    `curl -sX POST <CONTROL_PLANE_URL>${route} ` +
    `-H "Authorization: Bearer <OPERATOR_TOKEN>" ` +
    `-H "x-stepup-assertion: ${assertion}" ` +
    `-H "Content-Type: application/json" ` +
    `-d '${JSON.stringify(body)}'`
  );
}

async function main(): Promise<void> {
  let cmd: StepUpMintCommand;
  try {
    cmd = parseStepUpMintArgv(process.argv.slice(2));
  } catch (e) {
    console.error(`[stepup] ${(e as Error).message}\n\n${STEPUP_MINT_USAGE}`);
    process.exit(2);
    return;
  }

  try {
    const assertion = mintStepUpAssertion(cmd, { secret: process.env.AUTOPROMOTE_STEPUP_SECRET });
    console.log(`[stepup] minted: action=${actionFor(cmd.target)} tenantId=${cmd.tenantId}`);
    console.log(assertion);
    console.log("");
    console.log("[stepup] single-use, expires 5 minutes from now — send the request below immediately:");
    console.log(curlFor(cmd, assertion));
    process.exit(0);
  } catch (e) {
    console.error(`[stepup] FAILED: ${(e as Error).message}`);
    process.exit(1);
  }
}

// Run only when invoked directly (`pnpm stepup:mint ...`), never on import — the test imports this module.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
