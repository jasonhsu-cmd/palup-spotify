import { describe, it, expect } from "vitest";
import { describeAutoGrant } from "./format";
import type { PalupFloor } from "@palup/platform-ports";

const discFloor: PalupFloor = { maxAutoPct: 30, maxAutoUsd: 50, massSendRecipientFloor: 500 };

describe("describeAutoGrant", () => {
  it("says approval-only when auto is off", () => {
    expect(describeAutoGrant("discount", { allowedAuto: false }, discFloor)).toMatch(/approval/i);
  });
  it("states the effective auto cap when on", () => {
    expect(describeAutoGrant("discount", { allowedAuto: true, maxPct: 15 }, discFloor)).toMatch(/15%/);
  });
  it("reflects the PalUp ceiling when the merchant sets above it (never claims more than the floor)", () => {
    expect(describeAutoGrant("discount", { allowedAuto: true, maxPct: 90 }, discFloor)).toMatch(/30%/); // clamped to floor
  });
});
