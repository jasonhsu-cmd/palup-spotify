import { describe, expect, it } from "vitest";
import { InMemoryRuntimeStore, type TelemetryEvent, type RuntimeStateCtx } from "@palup/platform-ports";
import { DEFAULT_POLICY, type Policy } from "@palup/widget-brain";
import { listArmTallies, readArmAggPair } from "@palup/state-postgres";
import { buildServer } from "../src/server.js";
import { HOLDOUT_PLAY, holdoutPeriod } from "../src/holdout.js";

// Wave 2 / W2-B — end-to-end coverage through the REAL /chat route (`buildServer`), mirroring
// canary.test.ts / champion.test.ts's own style. The unauthenticated /chat path serves the "demo"
// tenant (WIDGET_AUTH_REQUIRED off), so every probe below is unauthenticated and its holdout identity
// is therefore always the HASHED sessionId (never a verified shopperId — that path is exercised at the
// unit level in holdout.test.ts's holdoutIdentity tests).

const TENANT = { tenantId: "demo" };
const CHAMPION_POLICY: Policy = { id: "cand-x", label: "cand-x", styleDirective: "punchy, upbeat", proactivityDefault: "balanced" };
const period = holdoutPeriod();

// The IP-fairness rate limit bucket (`RL_IP_PER_MIN`, default 60/min — rate-limit.ts) keys off
// `x-forwarded-for`, and every `app.inject` call otherwise shares the SAME simulated client IP — which
// this file's larger fan-outs (hundreds of distinct sessions) would trip well before the per-tenant
// ceiling. Spreading a distinct, valid-looking IP per call (never reused) keeps each request inside its
// own IP bucket, exactly as distinct real shoppers would be, so the tests below exercise the HOLDOUT's
// own per-session/per-tenant limits rather than tripping an unrelated fairness bucket.
let ipCounter = 0;
function nextIp(): string {
  ipCounter++;
  return `10.${(ipCounter >> 16) & 0xff}.${(ipCounter >> 8) & 0xff}.${ipCounter & 0xff}`;
}

async function chat(app: Awaited<ReturnType<typeof buildServer>>, sessionId: string) {
  const res = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "x-forwarded-for": nextIp() },
    payload: { sessionId, message: "hi", signals: {} },
  });
  return res.json() as Record<string, unknown>;
}

async function turnEvents(store: InMemoryRuntimeStore): Promise<TelemetryEvent[]> {
  return (await store.readStream<TelemetryEvent>(TENANT, "telemetry")).filter((e) => e.kind === "turn");
}

describe("holdout OFF (the default) — byte-identical, no arm, no ledger write", () => {
  it("assigns no arm, tallies nothing, and leaves telemetry/traffic untouched by this feature", async () => {
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });
    try {
      for (const sessionId of ["s1", "s2", "s3"]) {
        const body = await chat(app, sessionId);
        expect(Object.keys(body)).not.toContain("arm");
      }
      // The pin: accumulateArmTally was NEVER called — the ledger has zero rows for this tenant.
      expect(await listArmTallies(store, "demo")).toEqual([]);
      // No telemetry "turn" row carries an `arm` key at all (InMemoryRuntimeStore's clone drops
      // undefined-valued keys on write/read, so this also proves the field was never populated).
      const events = await turnEvents(store);
      expect(events.length).toBeGreaterThan(0);
      for (const e of events) expect(Object.keys(e)).not.toContain("arm");
      // And no traffic row carries one either.
      const traffic = await store.readStream<Record<string, unknown>>(TENANT, "traffic");
      for (const t of traffic) expect(Object.keys(t)).not.toContain("arm");
    } finally {
      await app.close();
    }
  });

  it("an explicit enabled:false config (not just an absent one) behaves identically", async () => {
    const store = new InMemoryRuntimeStore();
    await store.put(TENANT, "holdout", "config", { enabled: false, fraction: 0.9 }); // fraction ignored while disabled
    const app = await buildServer({ store });
    try {
      const body = await chat(app, "s1");
      expect(Object.keys(body)).not.toContain("arm");
      expect(await listArmTallies(store, "demo")).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

describe("holdout ON at fraction 0.2 — stable per identity, arm-appropriate serving, exposures tallied", () => {
  it("assigns ~20% of distinct sessions to control, and every response is served by either the control or the champion policy", async () => {
    const store = new InMemoryRuntimeStore();
    await store.put(TENANT, "champion", "active", { policy: CHAMPION_POLICY });
    await store.put(TENANT, "holdout", "config", { enabled: true, fraction: 0.2 });
    const app = await buildServer({ store });
    try {
      const n = 300;
      const arms: Array<"control" | "treated"> = [];
      for (let i = 0; i < n; i++) {
        const body = await chat(app, `sess-${i}`);
        const servedBy = body.servedBy;
        if (servedBy === DEFAULT_POLICY.id) arms.push("control");
        else if (servedBy === CHAMPION_POLICY.id) arms.push("treated");
        else throw new Error(`unexpected servedBy: ${String(servedBy)}`);
      }
      const controlCount = arms.filter((a) => a === "control").length;
      // Loose bounds around the configured 20% — a hash-based split over 300 sessions, not a fair coin.
      expect(controlCount / n).toBeGreaterThan(0.1);
      expect(controlCount / n).toBeLessThan(0.3);

      // Exposures landed in the RIGHT arm's ArmTally row for this tenant/play/period.
      const { treated, control } = await readArmAggPair(store, "demo", HOLDOUT_PLAY, period);
      expect(control.exposures).toBe(controlCount);
      expect(treated.exposures).toBe(n - controlCount);
      expect(control.orders).toBe(0); // W2-C's order webhook populates these later, not this increment
      expect(treated.orders).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("an identity's arm is STABLE across repeated turns within the same period", async () => {
    const store = new InMemoryRuntimeStore();
    await store.put(TENANT, "champion", "active", { policy: CHAMPION_POLICY });
    await store.put(TENANT, "holdout", "config", { enabled: true, fraction: 0.5 });
    const app = await buildServer({ store });
    try {
      const sessionIds = Array.from({ length: 20 }, (_, i) => `stable-${i}`);
      const firstTurn = new Map<string, unknown>();
      for (const sessionId of sessionIds) firstTurn.set(sessionId, (await chat(app, sessionId)).servedBy);
      // Five more turns per session — every one must match the very first turn's servedBy.
      for (let round = 0; round < 5; round++) {
        for (const sessionId of sessionIds) {
          const servedBy = (await chat(app, sessionId)).servedBy;
          expect(servedBy).toBe(firstTurn.get(sessionId));
        }
      }
      // 20 identities × 6 turns each = 120 total exposures, split exactly along the FIRST-turn arms —
      // proves the persisted assignment, not a re-roll, drove every later turn.
      const { treated, control } = await readArmAggPair(store, "demo", HOLDOUT_PLAY, period);
      expect(control.exposures + treated.exposures).toBe(sessionIds.length * 6);
      const controlIdentities = [...firstTurn.values()].filter((v) => v === DEFAULT_POLICY.id).length;
      expect(control.exposures).toBe(controlIdentities * 6);
    } finally {
      await app.close();
    }
  });

  it("logs `arm` alongside `servedBy` in telemetry and the traffic log, joinable to the ledger", async () => {
    const store = new InMemoryRuntimeStore();
    await store.put(TENANT, "champion", "active", { policy: CHAMPION_POLICY });
    await store.put(TENANT, "holdout", "config", { enabled: true, fraction: 1 }); // force control, deterministic
    const app = await buildServer({ store });
    try {
      await chat(app, "sess-arm-logging");
      const events = await turnEvents(store);
      expect(events).toHaveLength(1);
      expect(events[0]?.arm).toBe("control");
      expect(events[0]?.servedBy).toBe(DEFAULT_POLICY.id);

      const traffic = await store.readStream<Record<string, unknown>>(TENANT, "traffic");
      expect(traffic).toHaveLength(1);
      expect(traffic[0]?.arm).toBe("control");
      expect(traffic[0]?.servedBy).toBe(DEFAULT_POLICY.id);
    } finally {
      await app.close();
    }
  });

  it("the /chat wire response itself does not carry `arm` — no widget change, telemetry-only", async () => {
    const store = new InMemoryRuntimeStore();
    await store.put(TENANT, "holdout", "config", { enabled: true, fraction: 1 });
    const app = await buildServer({ store });
    try {
      const body = await chat(app, "sess-wire");
      expect(Object.keys(body)).not.toContain("arm");
    } finally {
      await app.close();
    }
  });

  it("the CONTROL arm still honors the kill switch (a policy choice, never a bypass)", async () => {
    const store = new InMemoryRuntimeStore();
    await store.put(TENANT, "champion", "active", { policy: CHAMPION_POLICY });
    await store.put(TENANT, "holdout", "config", { enabled: true, fraction: 1 }); // force control
    await store.put({ tenantId: "__system__" }, "kill", "global", { scope: "global", reason: "test", at: new Date().toISOString() });
    const app = await buildServer({ store });
    try {
      const body = await chat(app, "sess-killed-control");
      expect(body.flags).toContain("no_autonomous_action");
    } finally {
      await app.close();
    }
  });
});

// A store whose ONLY injected fault is the holdout arm-assignment read (collection "holdout_assignment",
// the first store op inside `assignHoldoutArm`). Every other collection — the holdout config, the
// champion, the session, the ledger tally — behaves normally, so this isolates the ASSIGNMENT-write path
// exactly as a transient store/tx failure would, without disturbing the rest of the turn.
class AssignFailingStore extends InMemoryRuntimeStore {
  override async get<T>(ctx: RuntimeStateCtx, collection: string, key: string): Promise<T | null> {
    if (collection === "holdout_assignment") throw new Error("injected store failure (holdout assignment)");
    return super.get<T>(ctx, collection, key);
  }
}

describe("holdout ON but the arm-assignment write fails — F1 fail-open (security-review)", () => {
  it("serves the normal policy, leaves the turn UNMEASURED for both arms, and never breaks the reply", async () => {
    const store = new AssignFailingStore();
    await store.put(TENANT, "champion", "active", { policy: CHAMPION_POLICY });
    // fraction:1 WOULD force every shopper into control — proving the fail-open, since the assignment
    // never lands, the shopper is instead served the normal champion policy (unbiased), not control.
    await store.put(TENANT, "holdout", "config", { enabled: true, fraction: 1 });
    const app = await buildServer({ store });
    try {
      const body = await chat(app, "sess-assign-fail");
      // The reply is intact — NOT the generic model-error fallback the outer handler would produce
      // if the assignment throw propagated.
      expect((body.flags as string[] | undefined) ?? []).not.toContain("model_error");
      expect(typeof body.reply).toBe("string");
      expect((body.reply as string).length).toBeGreaterThan(0);
      // Served the normal champion policy (not control, not a crash) — the unbiased degradation.
      expect(body.servedBy).toBe(CHAMPION_POLICY.id);
      expect(Object.keys(body)).not.toContain("arm");
      // Left UNMEASURED for BOTH arms — no ledger write when the assignment couldn't be established.
      expect(await listArmTallies(store, "demo")).toEqual([]);
      // No telemetry "turn" row carries an arm either.
      const events = await turnEvents(store);
      expect(events.length).toBeGreaterThan(0);
      for (const e of events) expect(Object.keys(e)).not.toContain("arm");
    } finally {
      await app.close();
    }
  });
});
