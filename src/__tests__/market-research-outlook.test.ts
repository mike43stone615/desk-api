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
      lausTrend: trend(11),
    });
    expect(result.score).toBeGreaterThanOrEqual(85);
  });

  it("scores weakly when every trend is shrinking", () => {
    const result = scoreOutlook({
      bfsTrend: trend(-10),
      qcewTrend: trend(-8),
      beaGrowthPercent: -6,
      populationTrend: trend(-5),
      lausTrend: trend(-8),
    });
    expect(result.score).toBeLessThanOrEqual(20);
  });

  it("gives a neutral (not zero) contribution for a trend that could not be fetched", () => {
    const allMissing = scoreOutlook({
      bfsTrend: null,
      qcewTrend: null,
      beaGrowthPercent: null,
      populationTrend: null,
      lausTrend: null,
    });
    // 50% of each max: 12.5(rounds to 13) + 12.5(13) + 10 + 6 + 9 — should
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
      lausTrend: trend(6),
    });
    const missing = scoreOutlook({
      bfsTrend: null,
      qcewTrend: null,
      beaGrowthPercent: null,
      populationTrend: null,
      lausTrend: null,
    });
    expect(growing.score).toBeGreaterThan(missing.score);
  });

  it("scores lower for a business with all-shrinking trends than one with all-missing trends", () => {
    const shrinking = scoreOutlook({
      bfsTrend: trend(-10),
      qcewTrend: trend(-10),
      beaGrowthPercent: -10,
      populationTrend: trend(-10),
      lausTrend: trend(-10),
    });
    const missing = scoreOutlook({
      bfsTrend: null,
      qcewTrend: null,
      beaGrowthPercent: null,
      populationTrend: null,
      lausTrend: null,
    });
    expect(shrinking.score).toBeLessThan(missing.score);
  });

  it("mentions each of the five signals across the ranked reasons", () => {
    const result = scoreOutlook({
      bfsTrend: trend(4),
      qcewTrend: trend(4),
      beaGrowthPercent: 4,
      populationTrend: trend(4),
      lausTrend: trend(4),
    });
    expect(result.reasons).toHaveLength(5);
    const joined = result.reasons.join(" ").toLowerCase();
    expect(joined).toContain("business applications");
    expect(joined).toContain("establishments");
    expect(joined).toContain("personal income");
    expect(joined).toContain("population");
    expect(joined).toContain("unemployment rate");
  });

  it("ranks reasons by how many points each signal actually contributed", () => {
    const result = scoreOutlook({
      bfsTrend: trend(15), // strong growth -> full 25 points
      qcewTrend: trend(-10), // shrinking -> low points
      beaGrowthPercent: null, // missing -> neutral ~50%
      populationTrend: trend(-10),
      lausTrend: trend(-10),
    });
    // The BFS trend (25-point max, maxed out) should be the most prevalent
    // reason; it must appear before the population trend note.
    const bfsIndex = result.reasons.findIndex((r) =>
      r.toLowerCase().includes("business applications"),
    );
    const popIndex = result.reasons.findIndex((r) =>
      r.toLowerCase().includes("population"),
    );
    expect(bfsIndex).toBeGreaterThanOrEqual(0);
    expect(popIndex).toBeGreaterThanOrEqual(0);
    expect(bfsIndex).toBeLessThan(popIndex);
  });

  it("blends in the LAUS unemployment-rate trend as a fifth signal", () => {
    const improving = scoreOutlook({
      bfsTrend: trend(4),
      qcewTrend: trend(4),
      beaGrowthPercent: 4,
      populationTrend: trend(4),
      lausTrend: trend(12), // unemployment falling strongly (already inverted)
    });
    const worsening = scoreOutlook({
      bfsTrend: trend(4),
      qcewTrend: trend(4),
      beaGrowthPercent: 4,
      populationTrend: trend(4),
      lausTrend: trend(-12), // unemployment rising strongly
    });
    expect(improving.score).toBeGreaterThan(worsening.score);
  });

  it("reaches exactly 100 when every signal, including LAUS, is maxed", () => {
    // bfs(25) + qcew(25) + bea(20) + population(12) + laus(18) = 100.
    const result = scoreOutlook({
      bfsTrend: trend(9),
      qcewTrend: trend(9),
      beaGrowthPercent: 9,
      populationTrend: trend(9),
      lausTrend: trend(9),
    });
    expect(result.score).toBe(100);
  });

  describe("percentile-cache decile buckets (reference-distribution-cache.ts)", () => {
    // Regression guard: omitting the five bucket fields entirely (as every
    // pre-existing test above does) or passing them as explicit null must
    // both reproduce the exact pre-rework hardcoded-band score.
    it("omitted buckets and explicit-null buckets both score identically to the pre-existing hardcoded-band behavior", () => {
      const input = {
        bfsTrend: trend(4),
        qcewTrend: trend(-6),
        beaGrowthPercent: 2,
        populationTrend: trend(-2),
        lausTrend: trend(9),
      };
      const omitted = scoreOutlook(input);
      const explicitNull = scoreOutlook({
        ...input,
        bfsPercentileBucket: null,
        qcewPercentileBucket: null,
        beaPercentileBucket: null,
        popPercentileBucket: null,
        lausPercentileBucket: null,
      });
      expect(explicitNull.score).toBe(omitted.score);
      expect(explicitNull.reasons).toEqual(omitted.reasons);
    });

    it("a real percentile bucket produces a different score than the hardcoded fallback for the same trendPercent", () => {
      const trendInput = {
        bfsTrend: trend(2), // ">0" fallback band -> 55% of 25 -> 14
        qcewTrend: null,
        beaGrowthPercent: null,
        populationTrend: null,
        lausTrend: null,
      };
      const fallback = scoreOutlook(trendInput);
      const withTopBucket = scoreOutlook({
        ...trendInput,
        bfsPercentileBucket: 10, // top decile nationally
      });
      const withBottomBucket = scoreOutlook({
        ...trendInput,
        bfsPercentileBucket: 1, // bottom decile nationally
      });
      expect(withTopBucket.score).toBeGreaterThan(fallback.score);
      expect(withBottomBucket.score).toBeLessThan(fallback.score);
      expect(withTopBucket.score).not.toBe(fallback.score);
    });

    it("names the real decile in the reasons text when a bucket is supplied, and names the fallback explicitly when it is not", () => {
      const withBucket = scoreOutlook({
        bfsTrend: trend(4),
        qcewTrend: null,
        beaGrowthPercent: null,
        populationTrend: null,
        lausTrend: null,
        bfsPercentileBucket: 8,
      });
      const withoutBucket = scoreOutlook({
        bfsTrend: trend(4),
        qcewTrend: null,
        beaGrowthPercent: null,
        populationTrend: null,
        lausTrend: null,
      });
      const bucketReason = withBucket.reasons.find((r) =>
        r.toLowerCase().includes("business applications"),
      );
      const fallbackReason = withoutBucket.reasons.find((r) =>
        r.toLowerCase().includes("business applications"),
      );
      expect(bucketReason).toContain("decile 8 of 10 nationally");
      expect(fallbackReason).toContain("Desk's fallback bands");
    });

    it("the qcew_establishment_trend bucket direction matches every other signal's, un-inverted (positive trendPercent + high bucket both mean 'good')", () => {
      const growingWithGoodBucket = scoreOutlook({
        bfsTrend: null,
        qcewTrend: trend(5),
        beaGrowthPercent: null,
        populationTrend: null,
        lausTrend: null,
        qcewPercentileBucket: 9,
      });
      const growingWithBadBucket = scoreOutlook({
        bfsTrend: null,
        qcewTrend: trend(5),
        beaGrowthPercent: null,
        populationTrend: null,
        lausTrend: null,
        qcewPercentileBucket: 1,
      });
      expect(growingWithGoodBucket.score).toBeGreaterThan(growingWithBadBucket.score);
    });

    it("lausPercentileBucket is read directly (not re-negated) so a rising bucket still means 'improving', matching lausTrend.trendPercent's own already-inverted convention", () => {
      const improvingBucket = scoreOutlook({
        bfsTrend: null,
        qcewTrend: null,
        beaGrowthPercent: null,
        populationTrend: null,
        lausTrend: trend(4), // "positive = improving" per fetchLausTrend
        lausPercentileBucket: 10, // should mean "most improved" too, not "unemployment rose the most"
      });
      const worseningBucket = scoreOutlook({
        bfsTrend: null,
        qcewTrend: null,
        beaGrowthPercent: null,
        populationTrend: null,
        lausTrend: trend(4),
        lausPercentileBucket: 1,
      });
      expect(improvingBucket.score).toBeGreaterThan(worseningBucket.score);
    });

    it("never exceeds 100 and never goes negative when every bucket is maxed or bottomed out", () => {
      const maxed = scoreOutlook({
        bfsTrend: trend(4),
        qcewTrend: trend(4),
        beaGrowthPercent: 4,
        populationTrend: trend(4),
        lausTrend: trend(4),
        bfsPercentileBucket: 10,
        qcewPercentileBucket: 10,
        beaPercentileBucket: 10,
        popPercentileBucket: 10,
        lausPercentileBucket: 10,
      });
      const bottomed = scoreOutlook({
        bfsTrend: trend(-4),
        qcewTrend: trend(-4),
        beaGrowthPercent: -4,
        populationTrend: trend(-4),
        lausTrend: trend(-4),
        bfsPercentileBucket: 1,
        qcewPercentileBucket: 1,
        beaPercentileBucket: 1,
        popPercentileBucket: 1,
        lausPercentileBucket: 1,
      });
      expect(maxed.score).toBeLessThanOrEqual(100);
      expect(bottomed.score).toBeGreaterThanOrEqual(0);
    });
  });
});
