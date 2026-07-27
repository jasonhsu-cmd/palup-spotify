import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import {
  createBrain,
  createSession,
  createMemorySessionStore,
  type Signals,
} from "@palup/widget-brain";
import { createModelPort, createGroundingPort } from "./model.js";

const here = dirname(fileURLToPath(import.meta.url));
const widgetHtml = readFileSync(
  join(here, "..", "..", "widget", "public", "index.html"),
  "utf8",
);

const { port: modelPort, name: modelName } = createModelPort();
const brain = createBrain(modelPort, createGroundingPort());
// Per-conversation state (latch / open-issues / pitch budget) persists here keyed by sessionId.
const sessions = createMemorySessionStore();

export function buildServer() {
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({ ok: true, model: modelName }));

  app.get("/", async (_req, reply) => {
    reply.type("text/html").send(widgetHtml);
  });

  app.post("/chat", async (req, reply) => {
    const body = (req.body ?? {}) as { message?: string; signals?: Signals; sessionId?: string };
    try {
      const session = createSession(brain, {
        sessionId: String(body.sessionId ?? "anon"),
        store: sessions,
      });
      const d = await session.send(String(body.message ?? ""), body.signals ?? {});
      // Only the shopper-safe fields leave the server (no system prompt, no raw signals echo).
      return {
        reply: d.reply,
        mode: d.mode,
        pitch: d.pitch,
        escalate: d.escalateToHuman,
        outbound: d.outbound,
        flags: d.flags,
      };
    } catch (e) {
      // A model/config failure must degrade gracefully — never hang or leak internals to the shopper.
      console.error(`[/chat] model error (${modelName}):`, (e as Error).message);
      reply.code(200);
      return {
        reply:
          "Sorry — I'm having trouble right now. Let me get a team member to help; please try again in a moment.",
        mode: "support",
        pitch: "none",
        escalate: true,
        flags: ["model_error"],
      };
    }
  });

  return app;
}

// Listen only when run directly (not when imported by a test).
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invoked === import.meta.url) {
  const port = Number(process.env.PORT ?? 8787);
  buildServer()
    .listen({ port, host: "127.0.0.1" })
    .then(() => console.log(`widget backend listening on http://127.0.0.1:${port}`))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
