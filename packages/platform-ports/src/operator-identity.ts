import { timingSafeEqual } from "node:crypto";
import type { IdentityPort, Principal } from "./identity-port.js";

// Minimal operator identity for the control-plane: a shared bearer token (sourced from the secrets
// port / env, never in code), compared in CONSTANT TIME. This is the interim, reversible, least-
// privilege gate — it closes the live unauthenticated-operator hole (NN #4 disarm / NN #2 promote)
// today; the docs' full posture (SSO/OIDC + passkey + step-up-on-kill/promote + two-person-for-promote,
// IAM §1-2) is the next increment behind this same port.
//
// FAIL-CLOSED: if no operator token is configured, every credential authenticates as anonymous, so all
// operator actions are denied — you cannot operate the control plane without configuring the token.
export function createOperatorTokenIdentity(secretToken: string | undefined): IdentityPort {
  const configured = secretToken && secretToken.length > 0 ? Buffer.from(secretToken) : null;
  return {
    async authenticate(credential): Promise<Principal> {
      if (!configured || !credential) return { kind: "anonymous" };
      const given = Buffer.from(credential);
      if (given.length !== configured.length || !timingSafeEqual(given, configured)) {
        return { kind: "anonymous" };
      }
      return { kind: "operator", operatorId: "operator" };
    },
    authorize(principal, action): boolean {
      // Default-deny: only an authenticated operator may perform `operator:*` actions.
      return principal.kind === "operator" && action.startsWith("operator:");
    },
  };
}
