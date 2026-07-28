import type { CommercePort, GroundingPort, ModelPort } from "@palup/platform-ports";
import { MockModelAdapter, StaticGroundingAdapter, MockCommerceAdapter } from "@palup/widget-brain";
import { createVertexAdapter, isVertexConfigured } from "@palup/model-vertex";

// Composition root: pick the real Vertex adapter when GOOGLE_CLOUD_PROJECT is set, else the
// deterministic mock. Feature code only ever sees a ModelPort — it never knows which (ADR-0001).
export function createModelPort(): { port: ModelPort; name: string } {
  if (isVertexConfigured()) {
    return { port: createVertexAdapter(), name: "vertex/gemini" };
  }
  return { port: new MockModelAdapter(), name: "mock" };
}

// Grounding source: static demo catalog for now; the Shopify adapter (Storefront MCP / Catalog API)
// swaps in here later behind the same port.
export function createGroundingPort(): GroundingPort {
  return new StaticGroundingAdapter();
}

// Commerce source: mock orders/policy/subscription for now; the Shopify adapter swaps in behind the port.
export function createCommercePort(): CommercePort {
  return new MockCommerceAdapter();
}
