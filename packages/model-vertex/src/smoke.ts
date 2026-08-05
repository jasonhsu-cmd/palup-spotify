// Live verification of the Vertex/Gemini path. Requires REAL GCP creds:
//   gcloud auth application-default login
//   export GOOGLE_CLOUD_PROJECT=... GOOGLE_CLOUD_LOCATION=us-central1 PALUP_MODEL=gemini-3.6-flash
//   pnpm model:smoke "optional custom prompt"
// This is the one command that proves the real model works end-to-end — it could not be run in the
// build environment (no creds), so treat the live path as UNVERIFIED until this prints a real reply.
//
// It now also exercises the EMBEDDING path (B3), which is the ONLY way to learn three things this repo
// currently cannot state: the real vector DIMENSION, the real per-call LATENCY, and whether the provider
// returns a token count at all. Nothing in the test suite measures those — a fake transport cannot.
import { canEmbed } from "@palup/platform-ports";
import { createVertexAdapter, isVertexConfigured } from "./create.js";

async function main() {
  if (!isVertexConfigured()) {
    console.error(
      "Not configured. Set GOOGLE_CLOUD_PROJECT (+ GOOGLE_CLOUD_LOCATION, PALUP_MODEL) and run\n" +
        "`gcloud auth application-default login` first.",
    );
    process.exit(2);
  }
  const adapter = createVertexAdapter();
  const prompt =
    process.argv[2] ??
    "Recommend a serum for oily, acne-prone skin and explain why in two sentences.";
  const t0 = Date.now();
  const res = await adapter.complete({
    messages: [
      { role: "system", content: "You are a concise, honest skincare store assistant." },
      { role: "user", content: prompt },
    ],
    temperature: 0,
  });
  console.log(`\n✅ LIVE Vertex/Gemini call OK (${Date.now() - t0}ms)`);
  console.log("model:", res.model, "| usage:", JSON.stringify(res.usage));
  console.log("reply:\n" + res.text + "\n");

  // ── the embedding path (B3) ──
  if (!canEmbed(adapter)) {
    console.error("❌ this adapter does not declare embed — createVertexAdapter should always wire it");
    process.exit(1);
  }
  // Two texts, so the run also proves the adapter's CHUNKING works against the real per-request cap:
  // at the default model that is one text per request ([E2]), i.e. two round-trips reassembled in order.
  const texts = ["ceramide barrier repair cream for dry skin", "waterproof zinc sunscreen SPF 50"];
  const t1 = Date.now();
  const emb = await adapter.embed({ texts });
  console.log(`✅ LIVE Vertex embedding call OK (${Date.now() - t1}ms for ${texts.length} texts)`);
  console.log(
    "embed model:",
    emb.model,
    "| MEASURED dimension:",
    emb.dimension,
    "| usage:",
    JSON.stringify(emb.usage) ?? "(none reported)",
  );
  console.log(
    `Record these three numbers: the dimension above is what a corpus gets PINNED to, the latency is\n` +
      `per ${texts.length} text(s), and ${emb.usage ? "the token count is what the cost meter will bill" : "NO token count came back, so embedding spend will be invisible to the cost meter"}.\n`,
  );
}

main().catch((e) => {
  console.error("\n❌ LIVE CALL FAILED:\n", e);
  process.exit(1);
});
