import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";

// THE DEFECT, at the level that matters: a champion (or canary) policy's `proactivityDefault` never
// reached the serving session, so the pitch budget was permanently BUDGET["balanced"] === 2 whatever the
// promoted policy said.
//
// server.ts built the session as
//   createSession(brainFor(tenantId, policy), { sessionId, store: sessions, autoPersist: false })
// with no `level`, so `opts.level ?? "balanced"` was always "balanced".
//
// This is the repo's recurring defect shape — correct code (the BUDGET table, and brain.ts's
// `signals.proactivityLevel ?? policy.proactivityDefault` fallback) with NO PRODUCTION CALLER. The
// session-level unit tests all passed before the fix, because `createSession` honours `level` perfectly
// well when someone actually passes it. Only a route-level test can catch "the server never does."
//
// It matters because `docs/adr/0014-*` records that the `Policy` type holds ONLY `styleDirective` +
// `proactivityDefault` — so this is HALF of everything the self-improvement pipeline can produce. With
// the dial inert, a shadow/canary run of a proactivity candidate measures no difference from the
// incumbent, passes the gate looking safe, and then changes nothing on promotion.

const policy = (id: string, proactivityDefault: string) => ({
  id,
  label: id,
  styleDirective: "warm",
  proactivityDefault,
});

/** Drive one session until it stops pitching; return how many pitches it was allowed. */
async function pitchesAllowed(app: Awaited<ReturnType<typeof buildServer>>, sessionId: string) {
  let pitched = 0;
  for (let i = 0; i < 8; i++) {
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: {
        sessionId,
        message: "what do you recommend for dry skin?",
        signals: { cart: "has_items" },
        idempotencyKey: `${sessionId}-${i}`,
      },
    });
    const body = res.json();
    if (body.pitch && body.pitch !== "none") pitched++;
  }
  return pitched;
}

describe("a promoted champion's proactivityDefault reaches the serving pitch budget", () => {
  // BUDGET (session.ts): cautious 1, balanced 2, confident 4.
  it.each([
    ["cautious", 1],
    ["balanced", 2],
    ["confident", 4],
  ])("champion proactivityDefault=%s allows %i pitches", async (level, expected) => {
    const store = new InMemoryRuntimeStore();
    // Stands in for the control plane having promoted this champion for the demo merchant.
    await store.put({ tenantId: "demo" }, "champion", "active", { policy: policy(`champ-${level}`, level as string) });
    const app = await buildServer({ store });
    try {
      expect(await pitchesAllowed(app, `sess-${level}`)).toBe(expected);
    } finally {
      await app.close();
    }
  });

  it("THE DEFECT: the three champions must not all behave identically", async () => {
    const counts: number[] = [];
    for (const level of ["cautious", "balanced", "confident"]) {
      const store = new InMemoryRuntimeStore();
      await store.put({ tenantId: "demo" }, "champion", "active", { policy: policy(`champ-${level}`, level) });
      const app = await buildServer({ store });
      try {
        counts.push(await pitchesAllowed(app, `sess-d-${level}`));
      } finally {
        await app.close();
      }
    }
    expect(new Set(counts).size, `the dial is inert at the route — all three gave ${counts.join("/")}`).toBe(3);
    expect(counts[0]!).toBeLessThan(counts[1]!);
    expect(counts[1]!).toBeLessThan(counts[2]!);
  });

  it("a CANARY policy's dial is honoured too, so the pipeline can actually measure the change", async () => {
    // Without this, a canary that only changes proactivity is indistinguishable from the incumbent in
    // shadow/canary — the candidate looks safe because it does nothing, then does nothing on promote.
    const store = new InMemoryRuntimeStore();
    await store.put({ tenantId: "demo" }, "champion", "active", { policy: policy("champ", "confident") });
    await store.put({ tenantId: "demo" }, "canary", "config", {
      enabled: true,
      pct: 100,
      policy: policy("canary-cautious", "cautious"),
    });
    const app = await buildServer({ store });
    try {
      const first = await app.inject({
        method: "POST",
        url: "/chat",
        payload: { sessionId: "sess-canary", message: "hi", signals: {}, idempotencyKey: "k0" },
      });
      expect(first.json().servedBy).toBe("canary-cautious"); // pct 100 ⇒ this session is on the canary
      // The canary is cautious (budget 1) while the champion is confident (budget 4). If the dial did not
      // reach the session, this would come back 4 and the canary would be unmeasurable.
      expect(await pitchesAllowed(app, "sess-canary2")).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("no champion configured ⇒ DEFAULT_POLICY's balanced, unchanged from today", async () => {
    const app = await buildServer({ store: new InMemoryRuntimeStore() });
    try {
      expect(await pitchesAllowed(app, "sess-default")).toBe(2);
    } finally {
      await app.close();
    }
  });

  it("the dial is NOT client-settable — a shopper cannot buy themselves a bigger budget", async () => {
    // proactivityLevel is an autonomy lever; deriveServingSignals deliberately omits it from client input
    // (signals.ts). Passing the dial from the policy must not accidentally open a client route to it.
    const store = new InMemoryRuntimeStore();
    await store.put({ tenantId: "demo" }, "champion", "active", { policy: policy("champ-cautious", "cautious") });
    const app = await buildServer({ store });
    try {
      let pitched = 0;
      for (let i = 0; i < 8; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/chat",
          payload: {
            sessionId: "sess-spoof",
            message: "what do you recommend for dry skin?",
            signals: { cart: "has_items", proactivityLevel: "confident" }, // the spoof attempt
            idempotencyKey: `spoof-${i}`,
          },
        });
        const b = res.json();
        if (b.pitch && b.pitch !== "none") pitched++;
      }
      expect(pitched, "a client-supplied proactivityLevel widened the budget").toBe(1);
    } finally {
      await app.close();
    }
  });
});
