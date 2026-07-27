// Live verification of the Vertex/Gemini path. Requires REAL GCP creds:
//   gcloud auth application-default login
//   export GOOGLE_CLOUD_PROJECT=... GOOGLE_CLOUD_LOCATION=us-central1 PALUP_MODEL=gemini-3.6-flash
//   pnpm model:smoke "optional custom prompt"
// This is the one command that proves the real model works end-to-end — it could not be run in the
// build environment (no creds), so treat the live path as UNVERIFIED until this prints a real reply.
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
}

main().catch((e) => {
  console.error("\n❌ LIVE CALL FAILED:\n", e);
  process.exit(1);
});
