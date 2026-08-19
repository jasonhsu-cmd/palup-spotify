import { describe, it, expect, vi } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { mintStepUp, STEPUP_MAX_AGE_MS } from "@palup/platform-ports";
import { RUNTIME_AGENT_TYPE } from "../src/runtime-kill-registry.js";
import {
  autoPromoteGate,
  readAutoPromoteEnabled,
  readPlatformEnabled,
  setAutoPromoteOptIn,
  setPlatformAutoPromote,
  STEPUP_ACTION,
} from "../src/autopromote-optin.js";

// ADR-0014 cond #1/#2 + prereq #6 — the per-merchant opt-in flag and platform override. DEFAULT OFF /
// force-human; the SET is gated by a real step-up assertion + audited; an agent can NEVER flip it.

const SECRET = "elevated-stepup-secret";
const NOW = 1_754_000_000_000;
const stepUp = (tenantId: string, nonce: string, action = STEPUP_ACTION) =>
  mintStepUp(SECRET, { action, tenantId, iat: NOW, nonce });
const op = (tenantId: string, nonce: string, over = {}) => ({ actor: "jane.operator", stepUpToken: stepUp(tenantId, nonce), stepUpSecret: SECRET, now: NOW, ...over });

describe("autopromote opt-in (ADR-0014: default OFF, platform override wins, step-up + agent-proof)", () => {
  it("pure gate: BOTH must be on; the platform override wins (force-human whenever off)", () => {
    expect(autoPromoteGate({ tenantOptIn: false, globallyEnabled: false }).enabled).toBe(false);
    expect(autoPromoteGate({ tenantOptIn: true, globallyEnabled: false }).enabled).toBe(false); // platform off ⇒ force-human
    expect(autoPromoteGate({ tenantOptIn: false, globallyEnabled: true }).enabled).toBe(false);
    expect(autoPromoteGate({ tenantOptIn: true, globallyEnabled: true }).enabled).toBe(true); // only both-on enables
  });

  it("defaults OFF: an unset tenant flag AND an unset platform override ⇒ not enabled (dormant)", async () => {
    const store = new InMemoryRuntimeStore();
    expect((await readAutoPromoteEnabled(store, "acme")).enabled).toBe(false);
  });

  it("a step-up'd operator SET writes the flag + audits it in one tx; both-on ⇒ enabled", async () => {
    const store = new InMemoryRuntimeStore();
    await setAutoPromoteOptIn(store, "acme", true, op("acme", "n1"));
    await setPlatformAutoPromote(store, true, { actor: "jane.operator", stepUpToken: mintStepUp(SECRET, { action: "autopromote.platform.set", tenantId: "__system__", iat: NOW, nonce: "p1" }), stepUpSecret: SECRET, now: NOW });
    expect((await readAutoPromoteEnabled(store, "acme")).enabled).toBe(true);
    const audit = await store.readAudit({ tenantId: "acme" });
    expect(audit.some((a) => a.action.startsWith("autopromote.optin.set") && a.actor === "jane.operator")).toBe(true);
    expect((await store.verifyAudit({ tenantId: "acme" })).ok).toBe(true);
  });

  it("REFUSES an agent actor — an agent can never flip its own opt-in (NN #2 / inv #7)", async () => {
    const store = new InMemoryRuntimeStore();
    await expect(setAutoPromoteOptIn(store, "acme", true, op("acme", "na", { actor: "auto-loop" }))).rejects.toThrow(/human operator|agent/i);
    await expect(setAutoPromoteOptIn(store, "acme", true, op("acme", "nb", { actor: RUNTIME_AGENT_TYPE }))).rejects.toThrow(/human operator|agent/i);
    await expect(setAutoPromoteOptIn(store, "acme", true, op("acme", "nc", { actor: "" }))).rejects.toThrow(/human operator|agent/i);
    expect((await readAutoPromoteEnabled(store, "acme")).enabled).toBe(false); // nothing written
  });

  // The PLATFORM-MASTER switch shares the same setFlag/assertHumanActor guard as the tenant opt-in
  // above — this is the master switch itself (force-human whenever off, regardless of any tenant's
  // opt-in), so it gets its own direct assertion rather than relying only on the tenant-opt-in test to
  // exercise the shared code path.
  it("PLATFORM switch: REFUSES an agent actor — an agent can never flip the platform master switch", async () => {
    const store = new InMemoryRuntimeStore();
    const platformOp = (nonce: string, over = {}) => ({
      actor: "jane.operator",
      stepUpToken: mintStepUp(SECRET, { action: "autopromote.platform.set", tenantId: "__system__", iat: NOW, nonce }),
      stepUpSecret: SECRET,
      now: NOW,
      ...over,
    });
    await expect(setPlatformAutoPromote(store, true, platformOp("pa", { actor: "auto-loop" }))).rejects.toThrow(/human operator|agent/i);
    await expect(setPlatformAutoPromote(store, true, platformOp("pb", { actor: RUNTIME_AGENT_TYPE }))).rejects.toThrow(/human operator|agent/i);
    await expect(setPlatformAutoPromote(store, true, platformOp("pc", { actor: "" }))).rejects.toThrow(/human operator|agent/i);
    expect(await readPlatformEnabled(store)).toBe(false); // nothing written
  });

  it("fails CLOSED without a valid step-up (absent / wrong secret / wrong tenant)", async () => {
    const store = new InMemoryRuntimeStore();
    await expect(setAutoPromoteOptIn(store, "acme", true, op("acme", "n1", { stepUpToken: undefined }))).rejects.toThrow(/step-up/i);
    await expect(setAutoPromoteOptIn(store, "acme", true, op("acme", "n2", { stepUpSecret: undefined }))).rejects.toThrow(/step-up/i);
    // a step-up minted for a DIFFERENT tenant cannot set this one
    await expect(setAutoPromoteOptIn(store, "acme", true, { actor: "jane.operator", stepUpToken: stepUp("other", "n3"), stepUpSecret: SECRET, now: NOW })).rejects.toThrow(/step-up/i);
    expect((await readAutoPromoteEnabled(store, "acme")).enabled).toBe(false);
  });

  it("enforces SINGLE-USE: replaying the same step-up nonce is refused", async () => {
    const store = new InMemoryRuntimeStore();
    await setAutoPromoteOptIn(store, "acme", true, op("acme", "reuse"));
    await expect(setAutoPromoteOptIn(store, "acme", false, op("acme", "reuse"))).rejects.toThrow(/used|replay/i);
  });

  it("keeps the single-use nonce alive for the FULL window the assertion can still verify (no early-expiry replay)", async () => {
    vi.useFakeTimers();
    try {
      const base = NOW;
      vi.setSystemTime(base);
      const store = new InMemoryRuntimeStore();
      // Assertion dated slightly in the future (within clock skew), so its own freshness outlasts a
      // nonce TTL measured from usedAt — the exact gap the security review flagged.
      const token = mintStepUp(SECRET, { action: STEPUP_ACTION, tenantId: "acme", iat: base + 29_000, nonce: "skew1" });
      await setAutoPromoteOptIn(store, "acme", true, { actor: "jane.operator", stepUpToken: token, stepUpSecret: SECRET }); // uses faked Date.now()
      // Past maxAge-from-usedAt (the OLD TTL would have dropped the nonce here) but still inside the
      // assertion's freshness (iat + maxAge) — so without a longer nonce TTL the replay would slip through.
      vi.setSystemTime(base + STEPUP_MAX_AGE_MS + 5_000);
      await expect(setAutoPromoteOptIn(store, "acme", false, { actor: "jane.operator", stepUpToken: token, stepUpSecret: SECRET })).rejects.toThrow(/used|replay/i);
    } finally {
      vi.useRealTimers();
    }
  });
});
