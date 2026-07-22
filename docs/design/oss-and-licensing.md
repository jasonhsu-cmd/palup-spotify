# Design Spec — Open-Source Licensing Policy & Register

_Turns the "verify licenses / SBOM / candidates-not-guarantees" stance (`ARCHITECTURE.md` §4.5,
`SECURITY.md` §3, `README.md`) into an enforceable policy + a flagged candidate register + a CI gate.
Because PalUp is a commercial, revenue-handling SaaS aiming at a public-company valuation, a
copyleft/source-available/proprietary dependency in the wrong place is a real legal and margin risk._

> **Status caveat:** OSS license terms changed a lot in 2023–2025 (several projects re-licensed to
> source-available/BSL/SSPL). Every entry below is **"verify current terms at pin time"**, not
> settled fact. The **allowlist + CI gate**, not this snapshot, is the source of truth. Nothing is
> license-verified yet — there are no dependencies (no `packages/`, no lockfile); this spec is the
> policy the build enforces.

## 1. License policy (the allowlist)

| Tier | Licenses | Rule |
|---|---|---|
| **Allow (default)** | MIT, Apache-2.0, BSD-2/3-Clause, ISC, PostgreSQL, Unlicense, MPL-2.0 (file-level copyleft, OK for use) | Auto-clear at pin, recorded in SBOM |
| **Review (legal + `security-reviewer` sign-off required)** | LGPL, EPL, CDDL, CC-BY | Case-by-case; usually OK if not modified/statically linked |
| **Flag — copyleft, needs explicit approval + isolation** | **AGPL-3.0**, GPL-3.0 | Allowed **only** as an unmodified, network-isolated, separately-deployed service we don't distribute; **never** linked into shipped code or modified. Named-human + legal sign-off. |
| **Flag — source-available / non-OSI, needs commercial-terms review** | **SSPL, BSL, FSL, Elastic License, CockroachDB Enterprise License, Redis RSALv2** | Allowed **only** with a purchased license or confirmed within-terms use; legal sign-off recorded. Prefer a permissive fork. |
| **Deny** | Proprietary/no-license, "no commercial use", CC-NC, unknown/missing | Blocked by the CI gate. |

**Golden rule:** feature/agent code and anything we *distribute* depend only on **Allow-tier**
licenses. Copyleft/source-available components may exist **only** as isolated, unmodified,
separately-run infrastructure behind a port — never linked, never modified, never shipped.

## 2. Candidate-component register (flagged, with portable alternatives)

The ports-and-adapters design (ADR-0001) makes every one of these swappable, so a license problem is
an adapter choice, not a rewrite.

| Component | Named in | License (verify) | Verdict | Portable alternative |
|---|---|---|---|---|
| **CockroachDB** | ADR-0004 storage candidate | **Enterprise License** (paid for commercial prod, 2024) | **Flag** — don't assume free | **YugabyteDB** (Apache-2.0 core) |
| **Citus** | ADR-0004 candidate | **AGPL-3.0** extension | **Flag** — copyleft | YugabyteDB / vanilla-sharded PG |
| **Redis** (≥7.4) | data-platform cache | **RSALv2/SSPL** (non-OSI) | **Flag** — SaaS restriction | **Valkey** (Apache-2.0 fork) / Memcached (BSD) |
| **Grafana** | observability | **AGPL-3.0** | **Flag** — isolate, don't modify/ship | Keep isolated, or Apache-2.0 dashboards |
| **Sentry** (self-host) | observability | **FSL/BSL** (→Apache after ~2y) | **Flag** — commercial-terms review | GlitchTip (self-host) / SaaS under terms |
| **YugabyteDB** (core) | ADR-0004/0009 | Apache-2.0 | **Allow** | — |
| **Milvus / Qdrant** | ADR-0009 vector | Apache-2.0 | **Allow** | — |
| **pgvector / Postgres** | storage/vector | PostgreSQL license | **Allow** | — |
| **OpenTelemetry** | telemetry | Apache-2.0 | **Allow** | — |
| **React / Vite / Tailwind / Fastify / Node** | stack | MIT | **Allow** | — |
| **shadcn/ui** | design system | MIT (copy-in — we own the code) | **Allow** | — |
| **Memcached** | cache | BSD | **Allow** | — |
| **wshobson/agents, obra/superpowers, msitarzewski/agency-agents, addyosmani/agent-skills, superdesigndev/superdesign** | ARCHITECTURE §4.5 | **Unverified, varies per repo** | **Review each** | vet license individually; vendor + pin only if Allow-tier |

**Effect on prior ADRs:** ADR-0004 (storage) and the data-platform cache tier should **prefer the
Allow-tier options — YugabyteDB and Valkey/Memcached** — unless legal clears CockroachDB's paid
license or Redis's terms. This does not change the *architecture* (still portable Postgres + a cache
behind ports); it constrains the *engine pick*. Recorded as cross-notes in ADR-0004 and
`data-platform.md`.

## 3. Vendored code (agents/skills adopted as building blocks)

Per `ARCHITECTURE.md` §4.5: an external agent/skill is adopted only if its license is **Allow-tier**,
its version is **pinned**, it passes **`security-reviewer`**, and its behavior is **wrapped behind
PalUp's ports/policies** (never granted autonomy that bypasses HITL). **Preserve attribution +
LICENSE/NOTICE files** for every vendored component; record provenance in the SBOM.

## 4. CI gate (turns policy into enforcement)

- **SBOM generated every build** (all direct + transitive deps, with resolved licenses).
- **Automated license scan** classifies each dep against §1; **build fails on any Flag/Deny/unknown
  license** without a recorded exception (legal + `security-reviewer` sign-off, tied to the PR).
- **Deps are pinned + signed**; a license change on upgrade re-triggers the gate (re-licensing, e.g.
  a future Apache→BSL move, is caught at upgrade, not silently inherited).
- Integrated into the `release-manager` / `/governance-check` flow (`compute-and-delivery.md` §5).

## 5. Invariants (tests / `security-reviewer` + legal)

1. No shipped/linked/feature code depends on a non-Allow-tier license. 2. Copyleft/source-available
components exist only as isolated, unmodified, separately-deployed infra behind a port. 3. The CI
license scan fails the build on any Flag/Deny/unknown without a recorded legal sign-off. 4. Every
dependency (direct + transitive) is in the SBOM with a resolved license. 5. Vendored components keep
attribution + NOTICE and are pinned + reviewed. 6. A re-license on upgrade re-triggers the gate.

## 6. Honest bottom line

There is **no verified license clearance today** — nothing is adopted. What this pass delivers is the
**policy, the allowlist, the flagged register (with the CockroachDB / Redis / Grafana / Sentry /
Citus traps called out), and the enforcing CI gate.** Actual per-dependency clearance happens in the
build when the SBOM exists; the gate guarantees nothing merges without it, and legal signs off on any
flagged component before it ships.
