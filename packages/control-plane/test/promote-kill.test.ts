import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { InMemoryRuntimeStore, type RuntimeStatePort } from "@palup/platform-ports";
import { armKill, RUNTIME_AGENT_TYPE } from "@palup/state-postgres";
import { DEFAULT_POLICY } from "@palup/widget-brain";
import { buildServer } from "../src/server.js";

// ADR-0014 / governance NN #4 ("the Kill Switch must always work"): the evolution PROMOTION path
// (approve -> promote) pushes new behavior to the LIVE shopper agent, so it must REFUSE when the
// operator's RUN-TIME kill is armed — the 3-scope registry an operator actually arms via
// /api/runtime-kill — not only the engine's in-process build-time kill. These tests drive the real
// control-plane routes with an INJECTED in-memory store, so a kill armed here is read on the SAME
// instance the promotion path checks. In addition, the existing engine in-process kill (engine.test.ts)
// must still pass — this backstop is additive.

const TOKEN = "test-op";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const CAND = "cand-warm-concise"; // seeded; MOCK quality 0.9 > champion 0.75 => passes the gate

type StateBody = {
  error?: string;
  champion: { policy: { id: string } };
  candidates: Array<{ policy: { id: string }; status: string }>;
};
const bodyOf = (r: { body: string }) => JSON.parse(r.body) as StateBody;
const statusOf = (b: StateBody, id: string) => b.candidates.find((c) => c.policy.id === id)?.status;

// Drive seed -> evaluate -> (optionally approve) so a candidate is ready to approve/promote. In mock
// mode (CP_MODE unset) evaluate resolves synchronously, so the candidate is awaiting_approval right after.
async function ready(app: Awaited<ReturnType<typeof buildServer>>, approve: boolean) {
  await app.inject({ method: "POST", url: "/api/seed", headers: AUTH });
  await app.inject({ method: "POST", url: `/api/evaluate/${CAND}`, headers: AUTH });
  // §3 NN#2 — staging is now a precondition of promotion, so the regression guard must walk it too.
  await app.inject({ method: "POST", url: `/api/stage/${CAND}`, headers: AUTH });
  await app.inject({ method: "POST", url: `/api/stage/${CAND}/shadow`, headers: AUTH, payload: { n: 200, delta: 0.02 } });
  await app.inject({ method: "POST", url: `/api/stage/${CAND}/canary`, headers: AUTH, payload: { n: 500, delta: 0.06, elapsedMs: 25 * 60 * 60 * 1000 } });
  if (approve) await app.inject({ method: "POST", url: `/api/approve/${CAND}`, headers: AUTH });
}

describe("control-plane promotion honors the RUN-TIME kill switch (fail-closed, NN #4)", () => {
  const prevToken = process.env.OPERATOR_TOKEN;
  const prevMode = process.env.CP_MODE;
  beforeAll(() => {
    process.env.OPERATOR_TOKEN = TOKEN; // mutating routes are default-deny without a bearer token
    delete process.env.CP_MODE; // force mock grader (deterministic; no live model)
  });
  afterAll(() => {
    if (prevToken === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = prevToken;
    if (prevMode === undefined) delete process.env.CP_MODE; else process.env.CP_MODE = prevMode;
  });

  it("GLOBAL kill makes /api/approve REFUSE (candidate stays awaiting_approval)", async () => {
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });
    try {
      await ready(app, false);
      await armKill(store, "global", "test");
      const res = await app.inject({ method: "POST", url: `/api/approve/${CAND}`, headers: AUTH });
      const b = bodyOf(res);
      expect(b.error).toMatch(/kill switch is ON/i);
      expect(statusOf(b, CAND)).toBe("awaiting_approval"); // NOT approved
    } finally {
      await app.close();
    }
  });

  it("AGENT-TYPE kill (agent:shopper) makes /api/promote REFUSE (champion unchanged)", async () => {
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });
    try {
      await ready(app, true); // approved, ready to promote
      await armKill(store, `agent:${RUNTIME_AGENT_TYPE}`, "test");
      const res = await app.inject({ method: "POST", url: `/api/promote/${CAND}`, headers: AUTH });
      const b = bodyOf(res);
      expect(b.error).toMatch(/kill switch is ON/i);
      expect(b.champion.policy.id).toBe(DEFAULT_POLICY.id); // still the original champion
    } finally {
      await app.close();
    }
  });

  it("no kill armed => /api/promote PROCEEDS as before (regression guard)", async () => {
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });
    try {
      await ready(app, true);
      const res = await app.inject({ method: "POST", url: `/api/promote/${CAND}`, headers: AUTH });
      const b = bodyOf(res);
      expect(b.error).toBeUndefined();
      expect(b.champion.policy.id).toBe(CAND); // promoted
    } finally {
      await app.close();
    }
  });

  it("FAIL CLOSED: an unreadable (throwing) kill registry is treated as KILLED", async () => {
    const store: RuntimeStatePort = new InMemoryRuntimeStore();
    // matchedKill reads the registry via store.list(SYSTEM, KILL); make that read throw. seed/evaluate
    // operate on the engine (not this store), so the pipeline still reaches the kill check on approve.
    (store as unknown as { list: () => Promise<never> }).list = async () => {
      throw new Error("registry down");
    };
    const app = await buildServer({ store });
    try {
      await ready(app, false);
      const res = await app.inject({ method: "POST", url: `/api/approve/${CAND}`, headers: AUTH });
      const b = bodyOf(res);
      expect(b.error).toMatch(/fail-closed/i);
      expect(statusOf(b, CAND)).toBe("awaiting_approval"); // refused: NOT approved
    } finally {
      await app.close();
    }
  });
});
