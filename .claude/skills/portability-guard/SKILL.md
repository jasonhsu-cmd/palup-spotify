---
name: portability-guard
description: >-
  Load whenever code needs a cloud/vendor/platform capability — model inference, vector
  search, queue/pubsub, blob storage, secrets, Shopify/commerce, payments, email/chat, or
  telemetry. Ensures access goes through a platform PORT with a swappable adapter (never a
  provider SDK in feature code), preserving portability per ADR-0001.
---

# Portability Guard

PalUp runs on Google Cloud today but must stay portable (ADR-0001). Every vendor-specific
capability is hidden behind a **port** in `packages/platform-ports/`, with adapters per
provider. Feature code and agents depend only on the port.

## The ports
`model` · `vector` · `queue` · `storage` · `secrets` · `commerce` (Shopify first) ·
`payments` · `comms` (email/chat) · `telemetry`.

## Before writing capability code, check
1. Is there a port for this capability? If not, define the interface first, then the Google
   adapter — don't inline the SDK.
2. Are you importing a provider SDK (`@google-cloud/*`, Vertex/Gemini SDK, etc.) from
   feature or agent code? → **Stop.** Move it behind the adapter.
3. Does the port interface leak provider-specific types/shapes? → normalize them; the port
   contract must be provider-neutral.
4. Is there a **contract test** the new adapter must satisfy? Adapters must be
   behavior-equivalent so a swap is safe.

## Pattern
```ts
// feature code — portable
import { modelPort } from '@palup/platform-ports';
const reply = await modelPort.generate({ tier: 'routine', messages });

// adapter (swappable) — the ONLY place the vendor SDK appears
// packages/platform-ports/model/adapters/vertex.ts
```

## Model tiering (via the model port, so it stays portable)
`routine` → fast tier · `high_stakes` → strong tier · `canary` → experimental variant,
capped to 1–5% by the evolution pipeline. The tier is a port concept; the mapping to a
specific provider model lives in the adapter/config.

## Red flags to block in review
- A provider SDK imported outside `packages/platform-ports/*/adapters/`.
- A region, model name, bucket, or endpoint hard-coded in feature code.
- A port method whose signature only makes sense for one vendor.
