import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import type { Policy } from "@palup/widget-brain";
import { AutoLoop, EvolutionEngine, FileStore, MemoryStore } from "../src/index.js";
import type { Grader, Proposer } from "../src/types.js";

const stripRound = (id: string) => id.replace(/-r\d+$/, "");
const champion: Policy = { id: "champion-v0", label: "Baseline", styleDirective: "x", proactivityDefault: "balanced" };

// prop-0 is a genuine improvement (0.5 -> 0.8, fixes `warm`); prop-1 is weaker.
const QUAL: Record<string, { q: number; pc: Record<string, number> }> = {
  "champion-v0": { q: 0.5, pc: { warm: 0.5, concise: 1 } },
  "prop-0": { q: 0.8, pc: { warm: 1, concise: 1 } },
  "prop-1": { q: 0.6, pc: { warm: 0.7, concise: 1 } },
};
// Equal counter-metrics across champion + candidates (ADR-0014 #5) — so the gate's counter-metrics check
// is satisfied (present + not-worse) and the promotion decision still turns on the quality delta, exactly
// as this test intends.
const CM = { returnRate: 0.08, complaintRate: 0.03, optOutRate: 0.1, escalationRecall: 1 };
const grader: Grader = {
  async grade(p) {
    const e = QUAL[stripRound(p.id)] ?? { q: 0.4, pc: { warm: 0.4, concise: 1 } };
    return { policyId: p.id, safetyPass: true, floorPass: true, qualityScore: e.q, perCriteria: e.pc, counterMetrics: CM };
  },
};
const proposer: Proposer = {
  async propose() {
    return [
      { id: "prop-0", label: "warmer", styleDirective: "be warmer", proactivityDefault: "balanced" },
      { id: "prop-1", label: "warmer-b", styleDirective: "be warmer b", proactivityDefault: "balanced" },
    ];
  },
};

describe("AutoLoop", () => {
  it("promotes the best improving candidate and records + persists the timeline", async () => {
    const store = new MemoryStore();
    const cm = await grader.grade(champion);
    const engine = new EvolutionEngine({ champion: { policy: champion, metrics: cm }, grader });
    const loop = new AutoLoop({ engine, grader, proposer, store, now: () => "T", autoApprove: true, minDelta: 0.05, candidatesPerRound: 2 });

    const tl = await loop.run(3);

    expect(tl[0]!.event).toBe("baseline");
    expect(tl[0]!.qualityAfter).toBe(0.5);
    const promo = tl.find((e) => e.event === "promoted")!;
    expect(promo).toBeTruthy();
    expect(promo.toPolicyId).toMatch(/^prop-0/); // picked the stronger candidate, not prop-1
    expect(promo.qualityBefore).toBe(0.5);
    expect(promo.qualityAfter).toBe(0.8);
    expect(promo.note).toMatch(/warm/); // targeted+improved criterion noted
    expect(engine.getChampion().policy.id).toMatch(/^prop-0/);
    // persisted
    expect((await store.readLog("improvement-timeline")).length).toBeGreaterThanOrEqual(2);
    expect(((await store.read("champion")) as { policy: Policy }).policy.id).toMatch(/^prop-0/);
    expect(engine.getHistory().length).toBe(1);
  });

  it("stops without promoting when no candidate beats the champion", async () => {
    const flat: Grader = {
      async grade(p) {
        return { policyId: p.id, safetyPass: true, floorPass: true, qualityScore: 0.5, perCriteria: { warm: 0.5, concise: 1 }, counterMetrics: CM };
      },
    };
    const store = new MemoryStore();
    const cm = await flat.grade(champion);
    const engine = new EvolutionEngine({ champion: { policy: champion, metrics: cm }, grader: flat });
    const loop = new AutoLoop({ engine, grader: flat, proposer, store, now: () => "T", autoApprove: true });

    const tl = await loop.run(2);
    expect(tl.some((e) => e.event === "promoted")).toBe(false);
    expect(tl.some((e) => e.event === "no_improvement")).toBe(true);
    expect(engine.getChampion().policy.id).toBe("champion-v0");
  });

  it("stops at awaiting_approval when autoApprove is off (HITL preserved)", async () => {
    const store = new MemoryStore();
    const cm = await grader.grade(champion);
    const engine = new EvolutionEngine({ champion: { policy: champion, metrics: cm }, grader });
    const loop = new AutoLoop({ engine, grader, proposer, store, now: () => "T", autoApprove: false });

    const tl = await loop.run(3);
    expect(tl.some((e) => e.event === "promoted")).toBe(false); // no auto-promotion
    expect(engine.getChampion().policy.id).toBe("champion-v0"); // champion unchanged until a human approves
    expect(engine.getCandidates().some((c) => c.status === "awaiting_approval")).toBe(true);
  });
});

describe("FileStore", () => {
  it("persists documents and logs across instances (survives restart)", async () => {
    const dir = join(tmpdir(), `palup-store-${Date.now()}`);
    try {
      const s1 = new FileStore(dir);
      await s1.write("champion", { policy: { id: "x" } });
      await s1.append("log", { a: 1 });
      await s1.append("log", { a: 2 });
      const s2 = new FileStore(dir); // simulate a process restart
      expect(((await s2.read("champion")) as { policy: { id: string } }).policy.id).toBe("x");
      expect((await s2.readLog("log")).length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
