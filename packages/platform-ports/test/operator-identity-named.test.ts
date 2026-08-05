import { describe, it, expect } from "vitest";
import { createOperatorTokenIdentity } from "../src/operator-identity.js";

// THE GAP: `authenticate` returned `{ kind: "operator", operatorId: "operator" }` for ANY valid token —
// a single literal id regardless of who presented it. So the control-plane had authentication (is this
// a valid operator?) but no IDENTITY (which operator?), and every governance action was attributed to
// the string "operator". With no distinguishable identities there can be no approver≠promoter check, no
// two-person rule, and no audit that says who actually approved a promotion to live traffic.
//
// This adds NAMED operators while keeping the single-token mode working unchanged, because that is what
// the current deployment uses (OPERATOR_TOKEN is set; nothing configures names yet).

describe("operator identity — named operators", () => {
  it("LEGACY single token still authenticates, as 'operator' (deployment-compatible)", async () => {
    const id = createOperatorTokenIdentity("secret-1");
    const p = await id.authenticate("secret-1");
    expect(p).toEqual({ kind: "operator", operatorId: "operator" });
  });

  it("a wrong token is anonymous, and an absent token is anonymous", async () => {
    const id = createOperatorTokenIdentity("secret-1");
    expect(await id.authenticate("nope")).toEqual({ kind: "anonymous" });
    expect(await id.authenticate(undefined)).toEqual({ kind: "anonymous" });
  });

  it("with NAMED tokens, each token resolves to its OWN operator id", async () => {
    const id = createOperatorTokenIdentity(undefined, { alice: "tok-alice", bob: "tok-bob" });
    expect(await id.authenticate("tok-alice")).toEqual({ kind: "operator", operatorId: "alice" });
    expect(await id.authenticate("tok-bob")).toEqual({ kind: "operator", operatorId: "bob" });
    expect(await id.authenticate("tok-carol")).toEqual({ kind: "anonymous" });
  });

  it("named tokens and the legacy token can coexist", async () => {
    const id = createOperatorTokenIdentity("legacy", { alice: "tok-alice" });
    expect((await id.authenticate("tok-alice")).kind).toBe("operator");
    expect((await id.authenticate("legacy")).kind).toBe("operator");
  });

  it("FAIL-CLOSED: no tokens configured at all ⇒ every credential is anonymous", async () => {
    const id = createOperatorTokenIdentity(undefined);
    expect(await id.authenticate("anything")).toEqual({ kind: "anonymous" });
    expect(await id.authenticate("")).toEqual({ kind: "anonymous" });
  });

  it("an EMPTY named token is ignored rather than matching an empty credential", async () => {
    const id = createOperatorTokenIdentity(undefined, { alice: "" });
    expect(await id.authenticate("")).toEqual({ kind: "anonymous" });
  });

  it("comparison stays length-safe across differing token lengths (no throw)", async () => {
    const id = createOperatorTokenIdentity(undefined, { alice: "short", bob: "a-much-longer-token" });
    expect((await id.authenticate("a-much-longer-token")).kind).toBe("operator");
    expect(await id.authenticate("x")).toEqual({ kind: "anonymous" });
  });

  it("reports how many distinct operators are configured — what makes a two-person rule satisfiable", () => {
    expect(createOperatorTokenIdentity("legacy").operatorCount).toBe(1);
    expect(createOperatorTokenIdentity(undefined, { alice: "a", bob: "b" }).operatorCount).toBe(2);
    expect(createOperatorTokenIdentity(undefined).operatorCount).toBe(0);
  });
});
