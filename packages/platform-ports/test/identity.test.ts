import { describe, it, expect } from "vitest";
import { createOperatorTokenIdentity } from "../src/operator-identity.js";

describe("operator token identity (default-deny)", () => {
  it("authenticates a matching bearer token as operator; authorizes operator actions", async () => {
    const id = createOperatorTokenIdentity("s3cret");
    const p = await id.authenticate("s3cret");
    expect(p).toEqual({ kind: "operator", operatorId: "operator" });
    expect(id.authorize(p, "operator:kill")).toBe(true);
    expect(id.authorize(p, "operator:promote")).toBe(true);
  });

  it("treats a wrong / absent credential as anonymous and DENIES (default-deny)", async () => {
    const id = createOperatorTokenIdentity("s3cret");
    for (const cred of [undefined, "", "wrong", "s3cre", "s3cret "]) {
      const p = await id.authenticate(cred as string | undefined);
      expect(p.kind).toBe("anonymous");
      expect(id.authorize(p, "operator:kill")).toBe(false);
    }
  });

  it("FAILS CLOSED when no operator token is configured (cannot operate)", async () => {
    const id = createOperatorTokenIdentity(undefined);
    const p = await id.authenticate("anything");
    expect(p.kind).toBe("anonymous");
    expect(id.authorize(p, "operator:kill")).toBe(false);
  });

  it("does not authorize non-operator actions even for an operator (no scope creep)", async () => {
    const id = createOperatorTokenIdentity("s3cret");
    const p = await id.authenticate("s3cret");
    expect(id.authorize(p, "shopper:chat")).toBe(false);
    expect(id.authorize({ kind: "merchant", merchantId: "m1" }, "operator:kill")).toBe(false);
  });
});
