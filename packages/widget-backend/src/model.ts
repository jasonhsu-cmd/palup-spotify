import type { ModelPort } from "@palup/platform-ports";
import { MockModelAdapter } from "@palup/widget-brain";
import { createVertexAdapter, isVertexConfigured } from "@palup/model-vertex";

// Composition root: pick the real Vertex adapter when GOOGLE_CLOUD_PROJECT is set, else the
// deterministic mock. Feature code only ever sees a ModelPort — it never knows which (ADR-0001).
export function createModelPort(): { port: ModelPort; name: string } {
  if (isVertexConfigured()) {
    return { port: createVertexAdapter(), name: "vertex/gemini" };
  }
  return { port: new MockModelAdapter(), name: "mock" };
}
