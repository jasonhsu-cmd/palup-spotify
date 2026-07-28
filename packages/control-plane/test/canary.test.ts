import { describe, it, expect } from "vitest";
import { verdictFor } from "../src/canary-controller.js";

describe("canary shadow verdict", () => {
  it("promotes on a clear quality gain", () => expect(verdictFor(8, 0.10)).toBe("promote"));
  it("rolls back on a clear regression", () => expect(verdictFor(8, -0.10)).toBe("rollback"));
  it("holds within judge noise (±5pts)", () => {
    expect(verdictFor(8, 0.02)).toBe("hold");
    expect(verdictFor(8, -0.04)).toBe("hold");
  });
  it("reports no-traffic when there is nothing to grade", () => expect(verdictFor(0, 0)).toBe("no-traffic"));
});
