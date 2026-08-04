import { describe, it, expect } from "vitest";
import { scoreOutlook } from "../api/routes/integrations/market-research.js";

function trend(trendPercent: number) {
  return { trendPercent, oldestLabel: "2020", newestLabel: "2024" };
}

describe("scoreOutlook", () => {
  it("scores strongly when every trend is growing", () => {
    const result = scoreOutlook({
      bfsTrend: trend(15),
      qcewTrend: trend(12),
      beaGrowthPercent: 10,
      populationTrend: trend(9),
    });
    expect(result.score).toBeGreaterThanOrEqual(85);
  });

  it("scores weakly when every trend is shrinking", () => {
    const result = scoreOutlook({
      bfsTrend: trend(-10),
      qcewTrend: trend(-8),
      beaGrowthPercent: -6,
      populationTrend: trend(-5),
    });
    expect(result.score).toBeLessThanOrEqual(20);
  });

  it("gives a neutral (not zero) contribution for a trend that could not be fetched", () => {
    const allMissing = scoreOutlook({
      bfsTrend: null,
      qcewTrend: null,
      beaGrowthPercent: null,
      populationTrend: null,
    });
    // 50% of each max: 15 + 15 + 12.5(rounds to 13) + 8(rounds) — should
    // land near the middle, not collapse to (or near) zero the way a
    // missing-data-as-0 policy would.
    expect(allMissing.score).toBeGreaterThanOrEqual(45);
    expect(allMissing.score).toBeLessThanOrEqual(55);
  });

  it("scores higher for a business with all-positive trends than one with all-missing trends", () => {
    const growing = scoreOutlook({
      bfsTrend: trend(6),
      qcewTrend: trend(6),
      beaGrowthPercent: 6,
      populationTrend: trend(6),
    });
    const missing = scoreOutlook({
      bfsTrend: null,
      qcewTrend: null,
      beaGrowthPercent: null,
      populationTrend: null,
    });
    expect(growing.score).toBeGreaterThan(missing.score);
  });

  it("scores lower for a business with all-shrinking trends than one with all-missing trends", () => {
    const shrinking = scoreOutlook({
      bfsTrend: trend(-10),
      qcewTrend: trend(-10),
      beaGrowthPercent: -10,
      populationTrend: trend(-10),
    });
    const missing = scoreOutlook({
      bfsTrend: null,
      qcewTrend: null,
      beaGrowthPercent: null,
      populationTrend: null,
    });
    expect(shrinking.score).toBeLessThan(missing.score);
  });

  it("mentions each of the four signals in the rationale", () => {
    const result = scoreOutlook({
      bfsTrend: trend(4),
      qcewTrend: trend(4),
      beaGrowthPercent: 4,
      populationTrend: trend(4),
    });
    expect(result.rationale).toContain("business applications");
    expect(result.rationale).toContain("establishments");
    expect(result.rationale).toContain("personal income");
    expect(result.rationale).toContain("population");
  });
});
