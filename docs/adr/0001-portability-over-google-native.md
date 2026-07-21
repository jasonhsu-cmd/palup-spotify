# ADR-0001: Portable-first on Google Cloud (ports & adapters)

- **Status:** Accepted
- **Context:** PalUp already runs on Google Cloud (Vertex AI, Gemini, Cloud Run, GKE). The
  brief requires avoiding vendor lock-in and staying portable across clouds, commerce
  platforms, regions, and business models. PalUp's margin story and moat are core to a
  public-company valuation, so a forced dependency on one vendor's pricing/roadmap is a
  strategic risk.

## Decision
Keep using Google's managed services, but access every vendor-specific capability through a
**port** (interface) in `packages/platform-ports/`, with a Google **adapter** as the first
implementation. Ports: `model`, `vector`, `queue`, `storage`, `secrets`, `commerce`,
`payments`, `comms`, `telemetry`. Feature code and agents depend only on ports, never on a
provider SDK.

## Alternatives considered
- **Google-native everywhere.** Fastest to write; couples the whole business to one vendor.
  Rejected — the cost of unwinding it later dwarfs the port tax now.
- **Full multi-cloud from day one.** Maximum portability; large upfront cost and complexity
  with no current second-cloud requirement. Rejected as premature.

## Consequences
- (+) Second model provider, region, or cloud becomes "write an adapter," not a rewrite.
- (+) Portability is enforceable in review (the `portability-guard` skill / `/governance-check`).
- (−) One indirection layer and the discipline to keep vendor SDKs out of feature code.
- (−) Adapters must be kept behavior-equivalent; contract tests required per port.
