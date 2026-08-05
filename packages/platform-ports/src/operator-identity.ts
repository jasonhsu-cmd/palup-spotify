import { timingSafeEqual } from "node:crypto";
import type { IdentityPort, Principal } from "./identity-port.js";

// Operator identity for the control-plane: bearer tokens (sourced from the secrets port / env, never in
// code), compared in CONSTANT TIME. This is the interim, reversible, least-privilege gate; the docs' full
// posture (SSO/OIDC + passkey + step-up-on-kill/promote, IAM §1-2) is the next increment behind this same
// port.
//
// NAMED OPERATORS (2026-08-05). This previously returned `operatorId: "operator"` for ANY valid token —
// a single literal id regardless of who presented it. So the plane had AUTHENTICATION (is this a valid
// operator?) but no IDENTITY (which one?), and every governance action was attributed to the string
// "operator". Without distinguishable identities there can be no approver≠promoter check, no two-person
// rule, and no audit that records who actually pushed a policy to live traffic — the audit chain was
// cryptographically sound and semantically anonymous.
//
// `named` maps operatorId -> token. The legacy single `secretToken` still works and still resolves to
// "operator", so an existing deployment is unaffected until names are configured.
//
// FAIL-CLOSED: with nothing configured, every credential is anonymous and all operator actions are
// denied — you cannot operate the control plane without configuring a token.

export interface OperatorIdentityPort extends IdentityPort {
  /** How many DISTINCT operator identities are configured. A two-person rule is only satisfiable at >= 2;
   * the control-plane reads this to decide whether it can enforce approver != promoter, rather than
   * silently "passing" a rule that one shared token makes meaningless. */
  readonly operatorCount: number;
}

/** Constant-time compare that tolerates differing lengths (timingSafeEqual throws on a length mismatch). */
function tokenMatches(given: Buffer, configured: Buffer): boolean {
  return given.length === configured.length && timingSafeEqual(given, configured);
}

export function createOperatorTokenIdentity(
  secretToken: string | undefined,
  named?: Record<string, string>,
): OperatorIdentityPort {
  // operatorId -> token buffer. Empty tokens are DROPPED, never registered: a blank entry would
  // otherwise authenticate a blank credential.
  const registry: Array<{ operatorId: string; token: Buffer }> = [];
  for (const [operatorId, token] of Object.entries(named ?? {})) {
    if (typeof token === "string" && token.length > 0) registry.push({ operatorId, token: Buffer.from(token) });
  }
  if (secretToken && secretToken.length > 0) registry.push({ operatorId: "operator", token: Buffer.from(secretToken) });

  return {
    operatorCount: registry.length,
    async authenticate(credential): Promise<Principal> {
      if (registry.length === 0 || !credential) return { kind: "anonymous" };
      const given = Buffer.from(credential);
      // Compare against EVERY registered token rather than short-circuiting, so the work done does not
      // depend on which operator matched (or on registry order).
      let matched: string | undefined;
      for (const entry of registry) {
        if (tokenMatches(given, entry.token)) matched = entry.operatorId;
      }
      return matched ? { kind: "operator", operatorId: matched } : { kind: "anonymous" };
    },
    authorize(principal, action): boolean {
      // Default-deny: only an authenticated operator may perform `operator:*` actions.
      return principal.kind === "operator" && action.startsWith("operator:");
    },
  };
}
