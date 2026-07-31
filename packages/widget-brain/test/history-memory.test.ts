import { describe, it, expect, vi } from "vitest";
import type { ModelPort, ModelRequest } from "@palup/platform-ports";
import { createRedactingModelPort } from "@palup/platform-ports";
import {
  createBrain,
  createSession,
  StaticGroundingAdapter,
  normalizeHistory,
  HISTORY_MAX_TURNS,
  HISTORY_MAX_CHARS,
} from "../src/index.js";
import type { HistoryTurn } from "../src/index.js";

// The flagship "widget doesn't remember" fix: the CLIENT replays a bounded recent transcript on each
// turn and the brain threads it into the model context (groundedMessages), so a follow-up has its
// antecedent. The reply CONTENT is the live model's job; what we lock deterministically here is the
// message ARRAY the model port receives — via a spy on that port.
function spyBrain() {
  const spy = vi.fn<ModelPort["complete"]>(async () => ({ text: "ok", model: "spy" }));
  return { brain: createBrain({ complete: spy }, new StaticGroundingAdapter()), spy };
}
const lastMessages = (spy: ReturnType<typeof vi.fn>) =>
  (spy.mock.calls.at(-1)![0] as ModelRequest).messages;

describe("in-session multi-turn memory: history threading", () => {
  it("threads prior turns as [system, ...history, currentUser] in order", async () => {
    const { brain, spy } = spyBrain();
    const history: HistoryTurn[] = [
      { role: "user", content: "tell me about the vitamin-C serum" },
      { role: "agent", content: "The vitamin-C serum is fragrance-free." },
    ];
    await brain.decide({ cart: "has_items" }, "what about the other one?", history);
    const msgs = lastMessages(spy);
    expect(msgs[0].role).toBe("system");
    // Client "agent" role maps to the model's "assistant"; current turn is appended LAST.
    expect(msgs.slice(1)).toEqual([
      { role: "user", content: "tell me about the vitamin-C serum" },
      { role: "assistant", content: "The vitamin-C serum is fragrance-free." },
      { role: "user", content: "what about the other one?" },
    ]);
  });

  it("gives a follow-up its antecedent — the prior product is in the model context (not just the system prompt)", async () => {
    const { brain, spy } = spyBrain();
    await brain.decide({ cart: "has_items" }, "what about the other one?", [
      { role: "user", content: "is the vitamin-C serum fragrance-free?" },
      { role: "agent", content: "Yes, it is." },
    ]);
    // Filter OUT the system message so this proves the antecedent came from the threaded history.
    const conversation = lastMessages(spy).filter((m) => m.role !== "system").map((m) => m.content).join("\n");
    expect(conversation).toContain("vitamin-C serum");
  });

  it("preserves the existing [system, user] shape when NO history is passed (regression guard)", async () => {
    const { brain, spy } = spyBrain();
    await brain.decide({ cart: "has_items" }, "which serum is best?");
    const msgs = lastMessages(spy);
    expect(msgs).toHaveLength(2);
    expect(msgs.map((m) => m.role)).toEqual(["system", "user"]);
    expect(msgs[1]).toEqual({ role: "user", content: "which serum is best?" });
  });

  it("bounds an over-long history to the most-recent HISTORY_MAX_TURNS (client can't blow up the context)", async () => {
    const { brain, spy } = spyBrain();
    const history: HistoryTurn[] = Array.from({ length: 30 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "agent") as "user" | "agent",
      content: `turn-${i}`,
    }));
    await brain.decide({ cart: "has_items" }, "and now?", history);
    const threaded = lastMessages(spy).filter((m) => m.role !== "system").slice(0, -1); // drop current turn
    expect(threaded.length).toBe(HISTORY_MAX_TURNS);
    expect(threaded.map((m) => m.content)).toEqual([
      "turn-22", "turn-23", "turn-24", "turn-25", "turn-26", "turn-27", "turn-28", "turn-29",
    ]);
  });

  it("bounds a single oversized turn to the total char cap", async () => {
    const { brain, spy } = spyBrain();
    const huge = "x".repeat(HISTORY_MAX_CHARS + 6_000);
    await brain.decide({ cart: "has_items" }, "and now?", [{ role: "user", content: huge }]);
    const priorUser = lastMessages(spy).filter((m) => m.role === "user").slice(0, -1); // exclude current turn
    const total = priorUser.reduce((n, m) => n + m.content.length, 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(HISTORY_MAX_CHARS);
  });

  it("redacts threaded history at the model egress — a card in a PRIOR turn never reaches the provider", async () => {
    // Compose the SAME redacting model port used in prod (model.ts) around a spy standing in for the
    // provider. Threaded history are non-system messages, so createRedactingModelPort must mask them.
    const spy = vi.fn<ModelPort["complete"]>(async () => ({ text: "ok", model: "spy" }));
    const brain = createBrain(createRedactingModelPort({ complete: spy }), new StaticGroundingAdapter());
    await brain.decide({ cart: "has_items" }, "and the other one?", [
      { role: "user", content: "my card is 4111 1111 1111 1111" },
      { role: "agent", content: "noted" },
    ]);
    const conversation = (spy.mock.calls.at(-1)![0] as ModelRequest).messages
      .filter((m) => m.role !== "system")
      .map((m) => m.content)
      .join(" ");
    expect(conversation).not.toContain("4111 1111 1111 1111");
    expect(conversation).toContain("[redacted-card]");
  });
});

describe("normalizeHistory (shared bound; never throws)", () => {
  it("drops non-arrays and malformed entries", () => {
    expect(normalizeHistory(undefined)).toEqual([]);
    expect(normalizeHistory("nope")).toEqual([]);
    expect(
      normalizeHistory([
        { role: "system", content: "x" }, // invalid role
        { role: "user" },                  // missing content
        { role: "user", content: "" },    // empty content
        null,
        { role: "user", content: "ok" },
      ]),
    ).toEqual([{ role: "user", content: "ok" }]);
  });

  it("keeps only the most recent N turns", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ role: "user" as const, content: `m${i}` }));
    const out = normalizeHistory(many);
    expect(out.length).toBe(HISTORY_MAX_TURNS);
    expect(out[0].content).toBe("m12");
    expect(out.at(-1)!.content).toBe("m19");
  });
});

describe("SessionState stays control-only (no server-side transcript)", () => {
  it("threads history to the brain but never records it in session state", async () => {
    const spy = vi.fn<ModelPort["complete"]>(async () => ({ text: "ok", model: "spy" }));
    const s = await createSession(createBrain({ complete: spy }, new StaticGroundingAdapter()));
    const MARKER = "UNIQUE-antecedent-marker-zzz";
    await s.send("what about the other one?", { cart: "has_items" }, [
      { role: "user", content: MARKER },
      { role: "agent", content: "sure" },
    ]);
    // The brain SAW the transcript (memory works)...
    const seen = (spy.mock.calls.at(-1)![0] as ModelRequest).messages.map((m) => m.content).join("\n");
    expect(seen).toContain(MARKER);
    // ...but the conversation state stored NONE of it (control-only: latch / issues / budget only).
    expect(JSON.stringify(s.state)).not.toContain(MARKER);
    expect("history" in (s.state as object)).toBe(false);
    expect("transcript" in (s.state as object)).toBe(false);
  });
});
