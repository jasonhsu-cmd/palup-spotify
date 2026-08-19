import { describe, it, expect } from "vitest";
import { verifyStepUp } from "@palup/platform-ports";
import { PLATFORM_STEPUP_ACTION, PLATFORM_TENANT, STEPUP_ACTION } from "@palup/state-postgres";
import {
  StepUpMintArgsError,
  actionFor,
  mintStepUpAssertion,
  parseStepUpMintArgv,
} from "../src/jobs/stepup-mint.js";

// The operator entry point that mints an `x-stepup-assertion` for the two ADR-0014 prereq #6 routes
// (`/api/autopromote/platform`, `/api/autopromote/optin`). `verifyStepUp` and the routes it guards were
// already tested (autopromote-optin.test.ts, autopromote-platform-route.test.ts); what's under test here
// is the OTHER end — does the CLI mint something a real deployment, verifying with the SAME secret,
// actually accepts, bound to the RIGHT action+tenant, and reject-cannot-be-fooled across a mismatched
// action (mirrors kill-switch-job.test.ts / holdout-cli.test.ts's own round-trip shape).

const SECRET = "elevated-stepup-secret";
const NOW = 1_754_000_000_000;

describe("stepup:mint — argument parsing", () => {
  it("an unknown or missing target is refused", () => {
    expect(() => parseStepUpMintArgv([])).toThrow(StepUpMintArgsError);
    expect(() => parseStepUpMintArgv(["merchant"])).toThrow(StepUpMintArgsError);
  });

  it("platform takes NO tenantId — it always binds to the reserved platform tenant", () => {
    expect(parseStepUpMintArgv(["platform"])).toEqual({ target: "platform", tenantId: PLATFORM_TENANT });
    expect(() => parseStepUpMintArgv(["platform", "acme"])).toThrow(StepUpMintArgsError);
  });

  it("optin REQUIRES a tenantId", () => {
    expect(() => parseStepUpMintArgv(["optin"])).toThrow(StepUpMintArgsError);
    expect(parseStepUpMintArgv(["optin", "acme"])).toEqual({ target: "optin", tenantId: "acme" });
  });

  it("a trailing unknown argument is refused", () => {
    expect(() => parseStepUpMintArgv(["optin", "acme", "extra"])).toThrow(StepUpMintArgsError);
  });
});

describe("stepup:mint — action constants are the SAME ones autopromote-optin.ts/server.ts use", () => {
  it("platform binds to PLATFORM_STEPUP_ACTION; optin binds to STEPUP_ACTION", () => {
    expect(actionFor("platform")).toBe(PLATFORM_STEPUP_ACTION);
    expect(actionFor("optin")).toBe(STEPUP_ACTION);
  });
});

describe("stepup:mint — fails CLOSED with no secret", () => {
  it("refuses to mint when the secret is unset", () => {
    expect(() => mintStepUpAssertion({ target: "platform", tenantId: PLATFORM_TENANT }, { secret: undefined })).toThrow(
      /AUTOPROMOTE_STEPUP_SECRET/,
    );
    expect(() => mintStepUpAssertion({ target: "optin", tenantId: "acme" }, { secret: "" })).toThrow(/AUTOPROMOTE_STEPUP_SECRET/);
  });
});

describe("stepup:mint — round-trip mint → verifyStepUp", () => {
  it("PLATFORM: mints an assertion verifyStepUp ACCEPTS for the platform action + tenant", () => {
    const assertion = mintStepUpAssertion({ target: "platform", tenantId: PLATFORM_TENANT }, { secret: SECRET, now: NOW, nonce: "p1" });

    const result = verifyStepUp(SECRET, assertion, { action: PLATFORM_STEPUP_ACTION, tenantId: PLATFORM_TENANT, now: NOW });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.nonce).toBe("p1");
  });

  it("OPTIN: mints an assertion verifyStepUp ACCEPTS for the tenant's opt-in action + tenant", () => {
    const assertion = mintStepUpAssertion({ target: "optin", tenantId: "acme" }, { secret: SECRET, now: NOW, nonce: "o1" });

    const result = verifyStepUp(SECRET, assertion, { action: STEPUP_ACTION, tenantId: "acme", now: NOW });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.nonce).toBe("o1");
  });

  it("REJECTS when verified against the OTHER action — actions are not interchangeable", () => {
    const platformAssertion = mintStepUpAssertion({ target: "platform", tenantId: PLATFORM_TENANT }, { secret: SECRET, now: NOW, nonce: "p2" });
    const optinAssertion = mintStepUpAssertion({ target: "optin", tenantId: "acme" }, { secret: SECRET, now: NOW, nonce: "o2" });

    expect(verifyStepUp(SECRET, platformAssertion, { action: STEPUP_ACTION, tenantId: PLATFORM_TENANT, now: NOW }).ok).toBe(false);
    expect(verifyStepUp(SECRET, optinAssertion, { action: PLATFORM_STEPUP_ACTION, tenantId: "acme", now: NOW }).ok).toBe(false);
  });

  it("REJECTS a mint for a DIFFERENT tenant than the one it's verified against (optin cross-tenant)", () => {
    const assertion = mintStepUpAssertion({ target: "optin", tenantId: "acme" }, { secret: SECRET, now: NOW, nonce: "o3" });

    expect(verifyStepUp(SECRET, assertion, { action: STEPUP_ACTION, tenantId: "other-co", now: NOW }).ok).toBe(false);
  });

  it("REJECTS when verified with a DIFFERENT secret than it was minted with", () => {
    const assertion = mintStepUpAssertion({ target: "platform", tenantId: PLATFORM_TENANT }, { secret: SECRET, now: NOW, nonce: "p3" });

    expect(verifyStepUp("wrong-secret", assertion, { action: PLATFORM_STEPUP_ACTION, tenantId: PLATFORM_TENANT, now: NOW }).ok).toBe(false);
  });

  it("mints a fresh random nonce per call when none is supplied — two mints never collide", () => {
    const a = mintStepUpAssertion({ target: "optin", tenantId: "acme" }, { secret: SECRET, now: NOW });
    const b = mintStepUpAssertion({ target: "optin", tenantId: "acme" }, { secret: SECRET, now: NOW });
    expect(a).not.toBe(b);
    const va = verifyStepUp(SECRET, a, { action: STEPUP_ACTION, tenantId: "acme", now: NOW });
    const vb = verifyStepUp(SECRET, b, { action: STEPUP_ACTION, tenantId: "acme", now: NOW });
    expect(va.ok && vb.ok).toBe(true);
    if (va.ok && vb.ok) expect(va.nonce).not.toBe(vb.nonce);
  });
});
