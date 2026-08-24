import { describe, it, expect } from "vitest";
import { cn } from "../src/lib/cn";

describe("cn", () => {
  it("joins truthy class strings and drops falsy ones", () => {
    expect(cn("btn", false && "hidden", undefined, null, "primary")).toBe("btn primary");
  });

  it("lets a later conflicting Tailwind class win over an earlier one", () => {
    expect(cn("text-ink", "text-ever")).toBe("text-ever");
  });

  it("supports the conditional-object form", () => {
    expect(cn("btn", { primary: true, block: false })).toBe("btn primary");
  });
});
