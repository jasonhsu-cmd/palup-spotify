// P4 go-live — LIVE staging smoke test for the OIDC-gated Pub/Sub push route (routes/pubsub-push.ts).
//
// WHY THIS EXISTS. The push route is INTERNET-REACHABLE (the service runs --allow-unauthenticated because
// /chat is public), so its OIDC verify + expected-SA check is the SOLE control between a stranger and a
// tenant re-index. The unit tests prove that logic with an INJECTED verifier; this proves it end-to-end on
// the DEPLOYED endpoint with a REAL Google-signed token — the go-live P4 precondition ("wrong-SA push
// refused") that must pass before CATALOG_WEBHOOKS is enabled.
//
// CREDENTIAL-FREE BY DESIGN. This script mints NO tokens and holds NO secrets — the operator supplies OIDC
// tokens via env (minted with the gcloud commands this prints), so it stays portable and leaks nothing into
// code, logs, or process args beyond the operator's own shell. SIDE-EFFECT-FREE: every probe sends a
// TENANT-LESS envelope, so a token that passes OIDC returns 204 (ack + drop) WITHOUT running a reconcile —
// we observe "did auth pass" (401 vs 204), never trigger a real re-index.
//
//   PUSH_SMOKE_URL=https://<service>/internal/pubsub/catalog-reconcile \
//     [WRONG_SA_TOKEN=...] [PUSH_SA_TOKEN=...] pnpm push:smoke
//
// The two always-on probes (no token, garbage token) need no creds and already prove the gate is closed.
// The two token probes are SKIPPED (loudly — never silently passed) unless the operator provides a token.

import { PUBSUB_PUSH_ROUTE } from "./routes/pubsub-push.js";

interface Probe {
  name: string;
  headers: Record<string, string>;
  expect: number;
  skip?: string; // set ⇒ not run (token not supplied); printed as SKIP, never counted as pass
}

// A well-formed push envelope with NO tenantKey: a token that passes OIDC yields 204 (ack + drop) here, so a
// positive probe proves auth WITHOUT triggering a reconcile. An auth failure is 401 before the body is read.
const TENANTLESS_BODY = JSON.stringify({ message: { attributes: {}, data: "" } });

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function main() {
  const base = process.env.PUSH_SMOKE_URL?.replace(/\/+$/, "");
  if (!base) {
    console.error("Set PUSH_SMOKE_URL to the deployed push endpoint, e.g.");
    console.error(`  PUSH_SMOKE_URL=https://<service-url>${PUBSUB_PUSH_ROUTE} pnpm push:smoke`);
    process.exit(2);
  }
  const url = base.endsWith(PUBSUB_PUSH_ROUTE) ? base : base + PUBSUB_PUSH_ROUTE;
  const wrongSa = process.env.WRONG_SA_TOKEN;
  const pushSa = process.env.PUSH_SA_TOKEN;

  const probes: Probe[] = [
    { name: "no Authorization header ⇒ 401 (anonymous refused)", headers: { "content-type": "application/json" }, expect: 401 },
    { name: "garbage bearer token ⇒ 401 (unverifiable refused)", headers: bearer("not-a-real-oidc-token"), expect: 401 },
    {
      name: "valid Google OIDC token, WRONG service account ⇒ 401 (Google-signed is NOT sufficient)",
      headers: wrongSa ? bearer(wrongSa) : {},
      expect: 401,
      skip: wrongSa ? undefined : "WRONG_SA_TOKEN not set",
    },
    {
      name: "valid OIDC token AS the push SA, correct audience ⇒ 204 (accepted, tenant-less drop — no reconcile)",
      headers: pushSa ? bearer(pushSa) : {},
      expect: 204,
      skip: pushSa ? undefined : "PUSH_SA_TOKEN not set",
    },
  ];

  console.log(`push smoke → ${url}\n`);
  let failed = 0;
  let ran = 0;
  for (const p of probes) {
    if (p.skip) {
      console.log(`  SKIP  ${p.name}\n        (${p.skip})`);
      continue;
    }
    ran++;
    let status: number | string;
    try {
      const res = await fetch(url, { method: "POST", headers: p.headers, body: TENANTLESS_BODY });
      status = res.status;
    } catch (e) {
      status = `network error: ${(e as Error).message}`;
    }
    const ok = status === p.expect;
    if (!ok) failed++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${p.name}\n        expected ${p.expect}, got ${status}`);
  }

  if (!wrongSa || !pushSa) {
    const proj = "<project>";
    console.log("\nTo run the token probes, mint OIDC tokens (audience MUST equal the endpoint URL) and re-run:");
    if (!wrongSa) {
      console.log(`  # WRONG SA — your own identity (any non-push Google SA): expected to be REFUSED (401)`);
      console.log(`  export WRONG_SA_TOKEN=$(gcloud auth print-identity-token --audiences="${url}")`);
    }
    if (!pushSa) {
      console.log(`  # PUSH SA — impersonate the configured push identity: expected ACCEPTED (204)`);
      console.log(`  export PUSH_SA_TOKEN=$(gcloud auth print-identity-token \\`);
      console.log(`      --impersonate-service-account=pubsub-catalog-push@${proj}.iam.gserviceaccount.com \\`);
      console.log(`      --audiences="${url}")   # needs roles/iam.serviceAccountTokenCreator on that SA`);
    }
  }

  console.log(`\n${failed === 0 ? "SMOKE OK" : "SMOKE FAIL"} — ${ran - failed}/${ran} probe(s) passed${failed ? `, ${failed} FAILED` : ""}.`);
  if (!wrongSa || !pushSa) {
    console.log("NOTE: token probe(s) were SKIPPED — this run did NOT verify a real push is accepted / a wrong SA is refused.");
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
