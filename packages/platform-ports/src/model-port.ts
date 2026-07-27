// Model port — the ONLY way feature code touches an LLM (ADR-0001, CLAUDE.md §5).
// Feature code depends on this interface, never on a provider SDK. Adapters (mock,
// Vertex/Gemini, …) implement it and are swapped behind the port.

export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelRequest {
  messages: ModelMessage[];
  /** Deterministic knob; adapters must honor 0 => reproducible output where possible. */
  temperature?: number;
  maxTokens?: number;
  /** Opaque per-tenant tag for isolation/attribution — never used to leak across tenants. */
  tenantId?: string;
}

export interface ModelResponse {
  text: string;
  /** Adapter/model identifier, for audit + eval provenance (e.g. "mock-1", "gemini-2.x"). */
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ModelPort {
  complete(req: ModelRequest): Promise<ModelResponse>;
}
