import { describe, it, expect } from "vitest";
import { allPairs } from "./pairwise.js";

describe("allPairs", () => {
  it("covers every pair of values across axes", () => {
    const axes = { mood: ["a", "b", "c"], cart: ["x", "y"], rel: ["p", "q", "r"] };
    const rows = allPairs(axes);
    const names = Object.keys(axes) as Array<keyof typeof axes>;

    // Verify every pair of axis-values co-occurs in at least one row
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const nameI = names[i]!;
        const nameJ = names[j]!;
        const valsI = axes[nameI];
        const valsJ = axes[nameJ];
        for (const vi of valsI) {
          for (const vj of valsJ) {
            const covered = rows.some((r) => r[nameI] === vi && r[nameJ] === vj);
            expect(covered).toBe(true);
          }
        }
      }
    }

    // Sanity: far fewer than the full cross product (3*2*3 = 18)
    expect(rows.length).toBeLessThan(18);
  });
});
