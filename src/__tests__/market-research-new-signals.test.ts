import { describe, expect, it } from "vitest";
import {
  locationQuotientFor,
  locationQuotientTier,
  ppiSeriesIdForNaics,
  targetMarketAdjustmentMultiplier,
  targetMarketFocusFor,
} from "../api/routes/integrations/market-research.js";

describe("locationQuotientFor", () => {
  it("returns null when local population is zero", () => {
    expect(locationQuotientFor(10, 0, 1000, 300_000_000)).toBeNull();
  });

  it("returns null when national establishments or population is zero/missing", () => {
    expect(locationQuotientFor(10, 50_000, 0, 300_000_000)).toBeNull();
    expect(locationQuotientFor(10, 50_000, 1000, 0)).toBeNull();
  });

  it("returns exactly 1.0 when local density equals national density", () => {
    // local: 10 establishments / 100,000 population = 0.0001
    // national: 3,000 establishments / 30,000,000 population = 0.0001
    expect(locationQuotientFor(10, 100_000, 3_000, 30_000_000)).toBeCloseTo(1, 5);
  });

  it("returns > 1 when the local area is more concentrated than the nation", () => {
    // local density is 4x the national density
    expect(locationQuotientFor(40, 100_000, 3_000, 30_000_000)).toBeCloseTo(4, 5);
  });

  it("returns < 1 when the local area is less concentrated than the nation", () => {
    expect(locationQuotientFor(5, 100_000, 3_000, 30_000_000)).toBeCloseTo(0.5, 5);
  });
});

describe("locationQuotientTier", () => {
  it("gives a neutral midpoint when LQ is unavailable", () => {
    expect(locationQuotientTier(null)).toBe(3);
  });

  it("scores highest for a typical (near-1.0) concentration", () => {
    expect(locationQuotientTier(1.0)).toBe(6);
    expect(locationQuotientTier(0.7)).toBe(6);
    expect(locationQuotientTier(1.4)).toBe(6);
  });

  it("scores a moderate tier for a wider but not extreme concentration", () => {
    expect(locationQuotientTier(2.0)).toBe(4);
    expect(locationQuotientTier(0.4)).toBe(4);
  });

  it("scores lowest for an extreme concentration or gap", () => {
    expect(locationQuotientTier(5.0)).toBe(2);
    expect(locationQuotientTier(0.1)).toBe(2);
  });
});

describe("targetMarketFocusFor", () => {
  it("detects a high-income focus", () => {
    expect(targetMarketFocusFor("affluent young professionals")).toBe("highIncome");
    expect(targetMarketFocusFor("luxury home buyers")).toBe("highIncome");
  });

  it("detects a budget focus", () => {
    expect(targetMarketFocusFor("budget-conscious families")).toBe("budget");
    expect(targetMarketFocusFor("affordable options for low-income renters")).toBe("budget");
  });

  it("returns null when neither pattern matches", () => {
    expect(targetMarketFocusFor("local homeowners")).toBeNull();
  });

  it("returns null when both patterns match (ambiguous/mixed signal)", () => {
    expect(targetMarketFocusFor("affordable luxury for everyone")).toBeNull();
  });
});

describe("targetMarketAdjustmentMultiplier", () => {
  it("returns exactly 1 when there is no focus", () => {
    expect(targetMarketAdjustmentMultiplier(null, 50, 10)).toBe(1);
  });

  it("scores up when the local high-income share is above the national baseline", () => {
    const multiplier = targetMarketAdjustmentMultiplier("highIncome", 48, 0);
    expect(multiplier).toBeGreaterThan(1);
  });

  it("scores down when the local high-income share is below the national baseline", () => {
    const multiplier = targetMarketAdjustmentMultiplier("highIncome", 6, 0);
    expect(multiplier).toBeLessThan(1);
  });

  it("scores up when the local budget share is above the national baseline for a budget focus", () => {
    const multiplier = targetMarketAdjustmentMultiplier("budget", 0, 44);
    expect(multiplier).toBeGreaterThan(1);
  });

  it("never exceeds the 0.7-1.3 clamp range regardless of how extreme the input is", () => {
    expect(targetMarketAdjustmentMultiplier("highIncome", 100, 0)).toBeLessThanOrEqual(1.3);
    expect(targetMarketAdjustmentMultiplier("highIncome", 0.01, 0)).toBeGreaterThanOrEqual(0.7);
  });
});

describe("ppiSeriesIdForNaics", () => {
  it("matches BLS's own documented worked example (NAICS 2211)", () => {
    expect(ppiSeriesIdForNaics("2211")).toBe("PCU2211--2211--");
  });

  it("pads a 2-digit sector code to 6 characters with hyphens", () => {
    expect(ppiSeriesIdForNaics("23")).toBe("PCU23----23----");
  });

  it("does not pad an already-6-digit code", () => {
    expect(ppiSeriesIdForNaics("722511")).toBe("PCU722511722511");
  });
});
