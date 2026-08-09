import { describe, expect, it } from "vitest";
import { formatCnyUnits } from "./money";

describe("formatCnyUnits", () => {
  it("formats wallet units as CNY with exactly two decimal places", () => {
    expect(formatCnyUnits(7_230_000)).toBe("¥7.23");
    expect(formatCnyUnits(10_000_000)).toBe("¥10.00");
    expect(formatCnyUnits(-1_250_000)).toBe("-¥1.25");
  });
});
