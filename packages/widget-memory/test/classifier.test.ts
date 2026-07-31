import { describe, it, expect } from "vitest";
import { classifyFact, type TenantSensitivityPolicy } from "../src/classifier.js";

// ADR-0015 Inv 11: conservative default over Art-9 categories (health/allergy/medical/pregnancy/
// biometric/genetic/sexual-orientation, …); a per-tenant policy may only NARROW what is remembered
// (drop a category), never reclassify special-category data as ordinary. Ambiguous/unknown → special.
describe("classifier — classifyFact (conservative, narrow-only sensitivity policy)", () => {
  it("classifies health/allergy facts as special", () => {
    expect(classifyFact("shopper mentioned a tree-nut allergy").class).toBe("special");
    expect(classifyFact("she said she is pregnant").class).toBe("special");
    expect(classifyFact("has eczema on the elbows").class).toBe("special");
  });

  it("classifies ordinary commerce facts as ordinary", () => {
    expect(classifyFact("prefers fragrance-free products").class).toBe("ordinary");
    expect(classifyFact("viewed the vitamin-C serum").class).toBe("ordinary");
  });

  it("a special-category classification defaults to remember:true absent any narrowing policy", () => {
    expect(classifyFact("has a peanut allergy").remember).toBe(true);
  });

  it("a tenant policy attempting to reclassify a special category as ordinary is IGNORED (Inv 11)", () => {
    // Even a malformed/malicious policy object (extra fields the type doesn't define) cannot flip the
    // class — the classifier only ever reads `dropCategories`, so there is no reclassify path to hit.
    const maliciousPolicy = {
      dropCategories: [],
      reclassifyAsOrdinary: ["medical"],
    } as unknown as TenantSensitivityPolicy;
    const result = classifyFact("has eczema and uses tretinoin", maliciousPolicy);
    expect(result.class).toBe("special");
    expect(result.remember).toBe(true);
  });

  it("a tenant policy MAY narrow (drop) a category — remember:false, class stays special (dropped, not downgraded)", () => {
    const policy: TenantSensitivityPolicy = { dropCategories: ["pregnancy"] };
    const result = classifyFact("shopper mentioned she is pregnant", policy);
    expect(result.class).toBe("special");
    expect(result.remember).toBe(false);
  });

  it("narrowing one category does not affect another category", () => {
    const policy: TenantSensitivityPolicy = { dropCategories: ["pregnancy"] };
    const result = classifyFact("has a tree-nut allergy", policy);
    expect(result.class).toBe("special");
    expect(result.remember).toBe(true);
  });

  it("ambiguous/boundary text defaults to special (conservative default, Inv 11)", () => {
    // "sensitive skin" sits right at the boundary between an ordinary preference and a dermatological
    // condition; the conservative default treats it as special rather than guessing it's benign.
    const result = classifyFact("shopper mentioned sensitive skin");
    expect(result.class).toBe("special");
  });

  it("drops a multi-category fact if ANY matched category is dropped (order-independent)", () => {
    // "allergic to soy and pregnant" matches BOTH allergy and pregnancy; dropping pregnancy must drop it
    // regardless of category match order (the old first-match logic missed this).
    const r = classifyFact("allergic to soy and I'm pregnant", { dropCategories: ["pregnancy"] });
    expect(r.class).toBe("special"); // class never narrows
    expect(r.remember).toBe(false); // but the drop is honored
  });
});
