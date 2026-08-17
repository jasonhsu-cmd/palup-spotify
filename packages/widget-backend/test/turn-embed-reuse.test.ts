import { describe, it, expect, afterEach } from "vitest";
import {
  InMemoryRuntimeStore,
  createInMemoryVectorStore,
  mintWidgetToken,
  type ModelPort,
  type ModelRequest,
  type ModelResponse,
  type EmbedRequest,
  type EmbedResponse,
  type TelemetryEvent,
} from "@palup/platform-ports";
import { TURN_EMBED_AGENT_TYPE } from "@palup/widget-brain";
import { buildServer } from "../src/server.js";
import { guestTokenHeader } from "./helpers/guest-token.js";

// semantic-memory-v1, PR3, T8 — SERVER-LEVEL composition proof: server.ts must construct the brain's
// shared `turnEmbedder` metered under `TURN_EMBED_AGENT_TYPE` (ADR-0013 — every provider spend is visible
// under its own agent type), and the turn must spend AT MOST one embed call for this purpose regardless of
// how many consumers (memory recall here; catalog retrieval is exercised separately, at the adapter level,
// in catalog-retriever-precomputed-vector.test.ts) are active this turn.
//
// RED TODAY, FOR AN UNAMBIGUOUS REASON: server.ts does not construct a `turnEmbedder` at all yet (no
// `createMeteringModelPort(..., { agentType: TURN_EMBED_AGENT_TYPE })` call site exists), so no
// `model_call` telemetry event with that `agentType` is ever recorded — the assertion below finds none.
//
// WHY MEMORY ALONE IS ENOUGH TO EXERCISE THIS (no catalog corpus/retrieval-enablement fixture needed): per
// PR3's own spec, the brain computes the shared vector "iff EITHER consumer is active (`memory && anonId`
// OR retrieval enabled)" — memory alone, with a real anonId, is already one of the two triggers.

const GUEST_SECRET = "turn-embed-guest-secret";
const WIDGET_SECRET = "turn-embed-widget-secret";
const TENANT = "demo"; // StaticGroundingAdapter's own fixture tenant — getShell resolves for it
// Base32 per validateAnonId's charset/length bound (`/^[A-Z2-7]{10,64}$/`, RFC4648 — excludes 0/1/8/9 to
// avoid confusion with O/I/B/Z). The digits in this id are deliberately 2's and a 3, never 0/1.
const ANON_ID = "TURNEMBEDHTTPGUEST2222222222223";
const WIDGET_TOKEN = mintWidgetToken(WIDGET_SECRET, TENANT, 3_600);

const ENV_KEYS = ["GUEST_TOKEN_SECRET", "MEMORY_SEMANTIC_RECALL", "WIDGET_TOKEN_SECRET", "WIDGET_AUTH_REQUIRED"];
afterEach(() => ENV_KEYS.forEach((k) => delete process.env[k]));

/** Records every embed() call (and, separately, every complete() call) it receives — shared across every
 *  metered wrapper server.ts builds around it, so a raw embed-call count here is the TOTAL turn-embed
 *  spend regardless of which agentType wrapper made the call. */
class SpyEmbedModel implements ModelPort {
  readonly completions: ModelRequest[] = [];
  readonly embeds: EmbedRequest[] = [];
  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.completions.push(req);
    return { text: "Great choice for dry skin — here's a gentle option.", model: "spy" };
  }
  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    this.embeds.push({ ...req, texts: [...req.texts] });
    return { vectors: req.texts.map(() => [0.1, 0.2, 0.3, 0.4]), dimension: 4, model: "spy-turn-embed", purpose: req.purpose };
  }
}

async function askWithGuest(app: Awaited<ReturnType<typeof buildServer>>, message: string) {
  return app.inject({
    method: "POST",
    url: "/chat",
    headers: { ...guestTokenHeader(GUEST_SECRET, TENANT, ANON_ID), authorization: `Bearer ${WIDGET_TOKEN}` },
    payload: {
      sessionId: "turn-embed-http-1",
      message,
      idempotencyKey: "turn-embed-http-key-1",
      signals: { cart: "empty" },
    },
  });
}

describe("T8 — server composition: the shared turn-embedder is metered under TURN_EMBED_AGENT_TYPE", () => {
  it("a clean sales turn with memory active (anonId present) attributes its query-embedding spend to TURN_EMBED_AGENT_TYPE", async () => {
    process.env.GUEST_TOKEN_SECRET = GUEST_SECRET;
    process.env.MEMORY_SEMANTIC_RECALL = "true";
    // go-live #3's coupling guard (assertMemoryAuthCoupling) refuses to boot with memory live unless
    // WIDGET_AUTH_REQUIRED is enforced — so this turn is authenticated with a real merchant widget token,
    // exactly like production would require once memory is live.
    process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
    process.env.WIDGET_AUTH_REQUIRED = "true";
    const model = new SpyEmbedModel();
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store, vectorPort: createInMemoryVectorStore(), modelPort: model, memoryEnabled: true });
    try {
      const res = await askWithGuest(app, "what do you recommend for dry skin?");
      expect(res.statusCode).toBe(200);

      const events = await store.readStream<TelemetryEvent>({ tenantId: TENANT }, "telemetry");
      const turnEmbedEvents = events.filter((e) => e.kind === "model_call" && e.agentType === TURN_EMBED_AGENT_TYPE);
      // TODAY: [] — server.ts constructs no turnEmbedder at all, so no model_call event is ever attributed
      // to TURN_EMBED_AGENT_TYPE, regardless of how many embed() calls happened under some OTHER agentType.
      expect(turnEmbedEvents.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it("STANDING COMPANION (already true, and must stay true): with memory OFF and no guest identity, NO model_call is ever attributed to TURN_EMBED_AGENT_TYPE", async () => {
    const model = new SpyEmbedModel();
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store, modelPort: model });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/chat",
        payload: { sessionId: "turn-embed-off-1", message: "what do you recommend for dry skin?", idempotencyKey: "turn-embed-off-key-1", signals: { cart: "empty" } },
      });
      expect(res.statusCode).toBe(200);
      const events = await store.readStream<TelemetryEvent>({ tenantId: TENANT }, "telemetry");
      expect(events.filter((e) => e.kind === "model_call" && e.agentType === TURN_EMBED_AGENT_TYPE)).toHaveLength(0);
      expect(model.embeds).toHaveLength(0); // no consumer active this turn ⇒ nothing to embed at all
    } finally {
      await app.close();
    }
  });
});
