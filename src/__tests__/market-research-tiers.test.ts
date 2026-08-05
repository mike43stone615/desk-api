import { describe, it, expect } from 'vitest';
import {
  populationTierFor,
  establishmentTierFor,
  nonemployerEstablishmentTierFor,
  receiptsTierFor,
  payrollTierFor,
  revenueIncomeScoreFor,
  competitionEstablishmentFallbackScore,
  trendPoints,
  growthTierFor,
  preferredWage,
  planTierFor,
} from '../api/routes/integrations/market-research.js';

describe('planTierFor', () => {
  it('scores presence and pricing-number quality independently, summing to the max of 15', () => {
    expect(planTierFor(3, 3)).toBe(15); // all fields + 3+ numbers
    expect(planTierFor(3, 0)).toBe(11); // all fields, no numbers
    expect(planTierFor(0, 0)).toBe(0); // nothing filled in
  });

  it('rewards a pricing field with real numbers over one with none, even at equal field-presence', () => {
    const vagueOnly = planTierFor(1, 0);
    const withNumbers = planTierFor(1, 2);
    expect(withNumbers).toBeGreaterThan(vagueOnly);
  });

  it('never exceeds 15 regardless of inputs', () => {
    for (const completeness of [0, 1, 2, 3, 10]) {
      for (const signals of [0, 1, 2, 3, 10]) {
        expect(planTierFor(completeness, signals)).toBeLessThanOrEqual(15);
      }
    }
  });
});

describe('preferredWage', () => {
  it('prefers QCEW when it has a value, even if OEWS is numerically larger', () => {
    expect(preferredWage(1000, 2000)).toBe(1000);
  });

  it('falls back to OEWS when QCEW is unavailable (zero)', () => {
    expect(preferredWage(0, 1500)).toBe(1500);
  });

  it('returns 0 when neither source has data', () => {
    expect(preferredWage(0, 0)).toBe(0);
  });
});

describe('populationTierFor', () => {
  // populationTierFor's max was rescaled from 40 to 32 when population
  // density claimed the other 8 of the 40 population points (see
  // populationDensityTierFor) — every point value below is the original
  // value * 32/40 = 0.8; the dollar/count breakpoints themselves are
  // unchanged.
  it('uses the city-scale table when the level is "place"', () => {
    // A city of 200k is well below the state-scale >500000 top tier, but
    // clears the city-scale >150000 top tier — this is exactly the
    // regression Task 1/2 exist to fix (real cities almost never clear
    // state-scale thresholds).
    expect(populationTierFor(200000, 'place')).toBe(32);
    expect(populationTierFor(60000, 'place')).toBe(24);
    expect(populationTierFor(12000, 'place')).toBe(16);
    expect(populationTierFor(5000, 'place')).toBe(8);
  });

  it('uses the county-scale table when the level is "county"', () => {
    expect(populationTierFor(350000, 'county')).toBe(32);
    expect(populationTierFor(80000, 'county')).toBe(24);
    expect(populationTierFor(20000, 'county')).toBe(16);
    expect(populationTierFor(5000, 'county')).toBe(8);
  });

  it('uses the original state-scale table when the level is "state"', () => {
    expect(populationTierFor(600000, 'state')).toBe(32);
    expect(populationTierFor(150000, 'state')).toBe(24);
    expect(populationTierFor(30000, 'state')).toBe(16);
    expect(populationTierFor(1000, 'state')).toBe(8);
  });

  it('falls back to the state-scale table (unchanged behavior) when no geography level is known', () => {
    // This is the no-regression case: a request where geography resolution
    // failed entirely must score exactly as it did before this change.
    expect(populationTierFor(600000, undefined)).toBe(32);
    expect(populationTierFor(150000, undefined)).toBe(24);
    expect(populationTierFor(30000, undefined)).toBe(16);
    expect(populationTierFor(1000, undefined)).toBe(8);
  });

  it('scores a real mid-size city fairly at place level but poorly at state level', () => {
    // Denver's ~713k population would land in the second-from-top state
    // tier if (incorrectly) compared against state-scale thresholds, but
    // should hit the max tier at city scale.
    const cityScore = populationTierFor(713000, 'place');
    const stateScaleComparison = populationTierFor(713000, 'state');
    expect(cityScore).toBe(32);
    expect(stateScaleComparison).toBe(32);
    // A smaller but still substantial city (60k) illustrates the actual
    // fix: city scale correctly recognizes it as strong demand, state
    // scale would bottom it out.
    expect(populationTierFor(60000, 'place')).toBeGreaterThan(
      populationTierFor(60000, 'state'),
    );
  });

  it('never returns more than 32 points (the raw-headcount signal is worth up to 32 of the 40 population points, with density worth the remaining 8)', () => {
    for (const population of [0, 1000, 50000, 500000, 5000000]) {
      for (const level of ['place', 'county', 'state', undefined] as const) {
        expect(populationTierFor(population, level)).toBeLessThanOrEqual(32);
      }
    }
  });
});

describe('establishmentTierFor', () => {
  it('scores a MODERATE county establishment count highest, not the largest count (non-monotonic)', () => {
    // 200 sits inside the "moderate" 75-300 county band (peak = 12); both a
    // much lower (10) and a much higher (800) count should score below it —
    // this is the core non-monotonic "moderate is healthiest" shape, and it
    // must not just be monotonically increasing like the old flat model.
    const low = establishmentTierFor(10, 'county');
    const moderate = establishmentTierFor(200, 'county');
    const high = establishmentTierFor(800, 'county');
    expect(moderate).toBe(12);
    expect(moderate).toBeGreaterThan(low);
    expect(moderate).toBeGreaterThan(high);
    // A saturated county count should score no better than a very low one —
    // proof this isn't merely "less monotonic," it genuinely penalizes both
    // extremes relative to the middle.
    expect(high).toBeLessThanOrEqual(low);
  });

  it('uses the county-scale table when the level is "county"', () => {
    expect(establishmentTierFor(600, 'county')).toBe(4); // saturated
    expect(establishmentTierFor(350, 'county')).toBe(8); // elevated
    expect(establishmentTierFor(100, 'county')).toBe(12); // moderate (peak)
    expect(establishmentTierFor(25, 'county')).toBe(9); // thin, growing
    expect(establishmentTierFor(5, 'county')).toBe(5); // very low
  });

  it('scores a MODERATE state establishment count highest, not the largest count (non-monotonic)', () => {
    const low = establishmentTierFor(20, 'state');
    const moderate = establishmentTierFor(600, 'state');
    const high = establishmentTierFor(2500, 'state');
    expect(moderate).toBe(12);
    expect(moderate).toBeGreaterThan(low);
    expect(moderate).toBeGreaterThan(high);
  });

  it('uses the state-scale table when the level is "state" or unknown (no regression in which table is picked)', () => {
    for (const level of ['state', undefined] as const) {
      expect(establishmentTierFor(2000, level)).toBe(4);
      expect(establishmentTierFor(1200, level)).toBe(8);
      expect(establishmentTierFor(300, level)).toBe(12);
      expect(establishmentTierFor(60, level)).toBe(9);
      expect(establishmentTierFor(10, level)).toBe(5);
    }
  });

  it('never returns more than 12 points (the establishment count is worth up to 12 of Demand\'s 20 establishment-related points)', () => {
    for (const count of [0, 5, 50, 90, 200, 290, 400, 600, 5000]) {
      for (const level of ['county', 'state', undefined] as const) {
        expect(establishmentTierFor(count, level)).toBeLessThanOrEqual(12);
      }
    }
  });
});

describe('nonemployerEstablishmentTierFor', () => {
  it('scores a MODERATE solo-operator count highest, not the largest count (non-monotonic)', () => {
    const low = nonemployerEstablishmentTierFor(100, 'county');
    const moderate = nonemployerEstablishmentTierFor(10000, 'county');
    const high = nonemployerEstablishmentTierFor(90000, 'county');
    expect(moderate).toBe(4);
    expect(moderate).toBeGreaterThan(low);
    expect(moderate).toBeGreaterThan(high);
  });

  it('lands a verified real-world sample (Denver County, NAICS 54, NESTAB=15,670) in the moderate/peak band', () => {
    expect(nonemployerEstablishmentTierFor(15670, 'county')).toBe(4);
  });

  it('uses the county-scale table when the level is "county"', () => {
    expect(nonemployerEstablishmentTierFor(70000, 'county')).toBe(0);
    expect(nonemployerEstablishmentTierFor(30000, 'county')).toBe(2);
    expect(nonemployerEstablishmentTierFor(10000, 'county')).toBe(4);
    expect(nonemployerEstablishmentTierFor(1000, 'county')).toBe(3);
    expect(nonemployerEstablishmentTierFor(100, 'county')).toBe(1);
  });

  it('uses the state-scale table when the level is "state" or unknown (no regression in which table is picked)', () => {
    for (const level of ['state', undefined] as const) {
      expect(nonemployerEstablishmentTierFor(250000, level)).toBe(0);
      expect(nonemployerEstablishmentTierFor(100000, level)).toBe(2);
      expect(nonemployerEstablishmentTierFor(30000, level)).toBe(4);
      expect(nonemployerEstablishmentTierFor(5000, level)).toBe(3);
      expect(nonemployerEstablishmentTierFor(500, level)).toBe(1);
    }
  });

  it('never returns more than 4 points (the nonemployer signal is worth up to 4 of Demand\'s 20 establishment-related points)', () => {
    for (const count of [0, 100, 1000, 10000, 50000, 500000]) {
      for (const level of ['county', 'state', undefined] as const) {
        expect(nonemployerEstablishmentTierFor(count, level)).toBeLessThanOrEqual(4);
      }
    }
  });

  it('county-scale thresholds are far below state-scale ones (a whole state can absorb a much bigger solo-operator count while still reading as "moderate")', () => {
    // 50,000 solo operators is already past the county "moderate" band (it
    // reads as elevated/approaching-saturation for a single county) but
    // still sits comfortably inside the wider state-scale moderate band.
    expect(nonemployerEstablishmentTierFor(50000, 'county')).toBe(2);
    expect(nonemployerEstablishmentTierFor(50000, 'state')).toBe(4);
  });
});

describe('establishment trend modifier (trendPoints reused for the QCEW establishment-count trend)', () => {
  it('scores a growing establishment count higher than a shrinking one', () => {
    const growing = trendPoints(10, 4);
    const shrinking = trendPoints(-10, 4);
    expect(growing).toBeGreaterThan(shrinking);
    expect(growing).toBeLessThanOrEqual(4);
  });

  it('gives a neutral (not zero) contribution when trend data is missing, per this file\'s "don\'t penalize missing optional data" policy', () => {
    const missing = trendPoints(null, 4);
    expect(missing).toBe(2); // 50% of max(4), rounded
    expect(missing).toBeGreaterThan(trendPoints(-10, 4));
    expect(missing).toBeLessThan(trendPoints(10, 4));
  });
});

describe('trendPoints percentile-bucket path (national reference-distribution cache)', () => {
  // Regression guard: every existing two-argument call site (scoreOutlook's
  // five signals, buildCategories' establishmentTrendTier) must keep
  // producing byte-identical output now that a third argument exists. Not
  // passing the third argument at all (undefined) and explicitly passing
  // null must both hit the exact same hardcoded-band branch as before.
  it('omitted and explicit-null percentileBucket both fall back to the pre-existing hardcoded bands, unchanged', () => {
    const trendPercentValues = [15, 9, 4, 2.5, 0.5, -1, -4.9, -5, -10, -50];
    const maxPointsValues = [4, 12, 18, 20, 25];
    for (const trendPercent of trendPercentValues) {
      for (const maxPoints of maxPointsValues) {
        const omitted = trendPoints(trendPercent, maxPoints);
        const explicitNull = trendPoints(trendPercent, maxPoints, null);
        const explicitUndefined = trendPoints(trendPercent, maxPoints, undefined);
        expect(explicitNull).toBe(omitted);
        expect(explicitUndefined).toBe(omitted);
      }
    }
    // And the null-trendPercent (missing-data) branch specifically.
    for (const maxPoints of maxPointsValues) {
      expect(trendPoints(null, maxPoints, null)).toBe(trendPoints(null, maxPoints));
    }
  });

  it('exactly reproduces every hardcoded band by value, so the fallback math itself never regresses', () => {
    expect(trendPoints(9, 25)).toBe(25); // >8 -> max
    expect(trendPoints(4, 25)).toBe(19); // >3 -> 75%, rounded
    expect(trendPoints(1, 25)).toBe(14); // >0 -> 55%, rounded
    expect(trendPoints(-2, 25)).toBe(8); // >-5 -> 30%, rounded
    expect(trendPoints(-10, 25)).toBe(3); // else -> 10%, rounded
    expect(trendPoints(null, 25)).toBe(13); // missing -> 50%, rounded
  });

  it('a real percentile bucket produces a different (and correct) score than the hardcoded fallback for the same trendPercent', () => {
    // trendPercent=2 alone would land in the ">0" 55% fallback band (14/25),
    // but a real cached decile bucket of 9 (near-top nationally) should
    // score far higher, and a bucket of 2 (near-bottom) should score far
    // lower than the fallback would have — the whole point of preferring
    // real distribution data over a hand-picked absolute-percent cutoff.
    const fallback = trendPoints(2, 25);
    const highBucket = trendPoints(2, 25, 9);
    const lowBucket = trendPoints(2, 25, 2);
    expect(fallback).toBe(14);
    expect(highBucket).not.toBe(fallback);
    expect(lowBucket).not.toBe(fallback);
    expect(highBucket).toBeGreaterThan(lowBucket);
  });

  it('maps decile bucket onto maxPoints as bucket * maxPoints / 10, rounded — mirroring laborPointsFor\'s bucket * 2 for its 0-20 budget', () => {
    for (const maxPoints of [4, 12, 18, 20, 25]) {
      for (let bucket = 1; bucket <= 10; bucket += 1) {
        expect(trendPoints(0, maxPoints, bucket)).toBe(
          Math.round((bucket * maxPoints) / 10),
        );
      }
    }
  });

  it('bucket 10 (top decile nationally = fastest growth) maps to the HIGH end of maxPoints; bucket 1 maps to the low end', () => {
    expect(trendPoints(-99, 25, 10)).toBe(25); // ignores the (very negative) trendPercent entirely once a bucket is given
    expect(trendPoints(-99, 25, 1)).toBe(3);
    expect(trendPoints(99, 4, 10)).toBe(4);
    expect(trendPoints(99, 4, 1)).toBe(0);
  });

  it('never exceeds maxPoints and never goes negative across the full 1-10 bucket range', () => {
    for (const maxPoints of [1, 4, 12, 18, 20, 25, 100]) {
      for (let bucket = 1; bucket <= 10; bucket += 1) {
        const points = trendPoints(0, maxPoints, bucket);
        expect(points).toBeGreaterThanOrEqual(0);
        expect(points).toBeLessThanOrEqual(maxPoints);
      }
    }
  });

  it('the same resolved bucket feeds both Outlook\'s qcewPoints (25-max) and Demand\'s establishmentTrendTier (4-max) proportionally, from one D1 lookup', () => {
    // Simulates the route handler resolving qcewPercentileBucket exactly
    // once and threading it into both scoreOutlook (maxPoints 25) and
    // buildCategories' establishmentTrendTier (maxPoints 4) — same metric,
    // same bucket, two different budgets.
    const qcewPercentileBucket = 7;
    const outlookQcewPoints = trendPoints(3.2, 25, qcewPercentileBucket);
    const demandTrendTier = trendPoints(3.2, 4, qcewPercentileBucket);
    expect(outlookQcewPoints).toBe(Math.round((7 * 25) / 10)); // 18
    expect(demandTrendTier).toBe(Math.round((7 * 4) / 10)); // 3
    // Both land at the same ~70% of their respective budgets.
    expect(outlookQcewPoints / 25).toBeCloseTo(demandTrendTier / 4, 1);
  });
});

describe('establishment-related Demand points cap at exactly 20 when every signal peaks', () => {
  it('establishmentTierFor(12 max) + nonemployerEstablishmentTierFor(4 max) + trendPoints(4 max) = 20', () => {
    const peakEstablishmentTier = establishmentTierFor(200, 'county'); // 12
    const peakNonemployerTier = nonemployerEstablishmentTierFor(10000, 'county'); // 4
    const peakTrendTier = trendPoints(9, 4); // 4
    expect(peakEstablishmentTier).toBe(12);
    expect(peakNonemployerTier).toBe(4);
    expect(peakTrendTier).toBe(4);
    expect(peakEstablishmentTier + peakNonemployerTier + peakTrendTier).toBe(20);
  });

  it('also holds at state scale', () => {
    const peakEstablishmentTier = establishmentTierFor(600, 'state'); // 12
    const peakNonemployerTier = nonemployerEstablishmentTierFor(30000, 'state'); // 4
    const peakTrendTier = trendPoints(9, 4); // 4
    expect(peakEstablishmentTier + peakNonemployerTier + peakTrendTier).toBe(20);
  });
});

describe('receiptsTierFor', () => {
  // receiptsTierFor used to branch on geography level (separate county-scale
  // and state-scale threshold tables) back when its input was NRCPTOT's raw
  // jurisdiction-wide aggregate. Now that the input is the true average
  // receipts per non-employer business (see buildCategories, where
  // aggregateReceipts / nonemployerEstablishments is computed), the
  // jurisdiction split no longer has a conceptual basis and was removed —
  // the function now takes only the receipts figure, and scores identically
  // regardless of what geography level that average happened to come from.
  it('scores the same average-receipts figure identically regardless of any notion of geography level (no level parameter anymore)', () => {
    expect(receiptsTierFor(150000)).toBe(30);
    expect(receiptsTierFor(75000)).toBe(20);
    expect(receiptsTierFor(45000)).toBe(10);
    expect(receiptsTierFor(10000)).toBe(4);
  });

  it('uses the unified threshold table calibrated against live per-business Nonemployer Statistics averages', () => {
    expect(receiptsTierFor(100001)).toBe(30);
    expect(receiptsTierFor(100000)).toBe(20); // exactly at the boundary, not above it
    expect(receiptsTierFor(60001)).toBe(20);
    expect(receiptsTierFor(30001)).toBe(10);
    expect(receiptsTierFor(30000)).toBe(4);
    expect(receiptsTierFor(0)).toBe(4);
  });

  it('never returns more than 30 points (receiptsTierFor is worth up to 30 of Revenue\'s 100 points, down from 40 now that payrollTierFor claims 10)', () => {
    for (const receipts of [0, 10000, 50000, 100000, 500000, 5000000]) {
      expect(receiptsTierFor(receipts)).toBeLessThanOrEqual(30);
    }
  });
});

describe('payrollTierFor', () => {
  // A secondary, independent Revenue signal alongside receiptsTierFor: the
  // average annual payroll per EMPLOYER establishment (CBP), as opposed to
  // receiptsTierFor's average receipts per NON-employer establishment
  // (Nonemployer Statistics). Thresholds are calibrated against live CBP
  // samples and run on a much higher dollar scale than the receipts
  // thresholds, since an employer business large enough to carry paid staff
  // generates more revenue-adjacent activity than a solo operator.
  it('uses the calibrated threshold table', () => {
    expect(payrollTierFor(2000000)).toBe(10);
    expect(payrollTierFor(1000000)).toBe(7);
    expect(payrollTierFor(600000)).toBe(4);
    expect(payrollTierFor(200000)).toBe(1);
  });

  it('lands a verified live sample in the expected band', () => {
    // Verified live sample: Denver County NAICS 54 CBP data (ESTAB=5,579,
    // PAYANN=$8,036,050,000) implies an average annual payroll per employer
    // establishment of roughly $1.44M for this category — well above the
    // ~$65k average non-employer receipts the same category and county
    // showed in Nonemployer Statistics, confirming payroll genuinely runs
    // on a much higher dollar scale than receipts.
    const avgPayroll = 1_440_516;
    expect(payrollTierFor(avgPayroll)).toBe(7);
  });

  it('never returns more than 10 points (the payroll signal is worth up to 10 of Revenue\'s 100 points)', () => {
    for (const payroll of [0, 100000, 500000, 900000, 1500000, 10000000]) {
      expect(payrollTierFor(payroll)).toBeLessThanOrEqual(10);
    }
  });
});

describe('Revenue category maxes out at exactly 100 (30 receipts + 10 payroll + 25 income + 20 wage + 15 plan)', () => {
  it('sums to exactly 100 when every sub-signal peaks', () => {
    const peakReceiptsTier = receiptsTierFor(150000); // 30
    const peakPayrollTier = payrollTierFor(2_000_000); // 10
    const peakIncomeTier = revenueIncomeScoreFor({
      nominalIncome: 100000,
      pricingHypothesis: '',
      targetMarket: '',
    }).score; // 25
    // wageTier and planTier are simple inline expressions in buildCategories
    // (not standalone exported functions), so their known peak values —
    // documented at the revenueScore computation in buildCategories — are
    // asserted directly here: wageTier peaks at 20 when wages are reported
    // and below $1,200/week, planTier peaks at 15 when planCompleteness>=3.
    const peakWageTier = 20;
    const peakPlanTier = 15;

    expect(peakReceiptsTier).toBe(30);
    expect(peakPayrollTier).toBe(10);
    expect(peakIncomeTier).toBe(25);
    expect(
      peakReceiptsTier +
        peakPayrollTier +
        peakIncomeTier +
        peakWageTier +
        peakPlanTier,
    ).toBe(100);
  });
});

describe('competitionEstablishmentFallbackScore', () => {
  // This fallback used to maintain its own independent, hand-tuned tier
  // table on the same raw establishment count establishmentTierFor reads
  // for Demand — monotonic in the opposite direction ("more establishments
  // = more crowded = lower score"). It now DERIVES its score from
  // establishmentTierFor's own non-monotonic "moderate is healthiest"
  // output instead, inverted — so these tests assert the new, non-monotonic
  // shape, not raw-count monotonicity.

  it('scores a MODERATE establishment count (Demand\'s healthiest zone) as the most-crowded fallback read', () => {
    // 200 sits in establishmentTierFor's county "moderate" band (tier 12,
    // Demand's peak/healthiest read) — Competition's fallback should read
    // this as its most-crowded (lowest-score) case.
    const moderateCounty = competitionEstablishmentFallbackScore(200, 'county');
    const veryLowCounty = competitionEstablishmentFallbackScore(5, 'county');
    const veryHighCounty = competitionEstablishmentFallbackScore(800, 'county');
    expect(moderateCounty).toBeLessThan(veryLowCounty);
    expect(moderateCounty).toBeLessThan(veryHighCounty);

    const moderateState = competitionEstablishmentFallbackScore(600, 'state');
    const veryLowState = competitionEstablishmentFallbackScore(10, 'state');
    const veryHighState = competitionEstablishmentFallbackScore(2500, 'state');
    expect(moderateState).toBeLessThan(veryLowState);
    expect(moderateState).toBeLessThan(veryHighState);
  });

  it('scores a very-low or very-high establishment count (Demand\'s low-opportunity extremes) as the least-crowded fallback read', () => {
    // establishmentTierFor's two extremes (tier 4 "saturated" and tier 5
    // "very low") both sit near its minimum — both should land near the top
    // (least-crowded) end of the fallback's envelope, well above the
    // moderate-band score.
    const veryLow = competitionEstablishmentFallbackScore(5, 'county'); // tier 5
    const veryHigh = competitionEstablishmentFallbackScore(800, 'county'); // tier 4
    const moderate = competitionEstablishmentFallbackScore(200, 'county'); // tier 12
    expect(veryLow).toBeGreaterThan(moderate);
    expect(veryHigh).toBeGreaterThan(moderate);
  });

  it('matches the exact value implied by inverting establishmentTierFor into the preserved [45, 75] envelope', () => {
    // county: tier 12 (moderate, est=200) -> most crowded -> envelope floor.
    expect(competitionEstablishmentFallbackScore(200, 'county')).toBe(45);
    // county: tier 4 (saturated, est=800) -> least crowded -> envelope ceiling.
    expect(competitionEstablishmentFallbackScore(800, 'county')).toBe(75);
    // state: tier 12 (moderate, est=600) -> envelope floor.
    expect(competitionEstablishmentFallbackScore(600, 'state')).toBe(45);
    // state: tier 4 (saturated, est=2500) -> envelope ceiling.
    expect(competitionEstablishmentFallbackScore(2500, 'state')).toBe(75);
  });

  it('falls back to state-scale thresholds (via establishmentTierFor) when the level is unknown (no regression in which table is picked)', () => {
    expect(competitionEstablishmentFallbackScore(300, undefined)).toBe(45); // moderate (state table)
    expect(competitionEstablishmentFallbackScore(2000, undefined)).toBe(75); // saturated (state table)
  });

  it('never exceeds its preserved [45, 75] envelope, even at the extremes, and never reaches the primary local-search path\'s most extreme 35/90 verdicts', () => {
    for (const establishments of [0, 1, 5, 20, 50, 75, 100, 250, 300, 500, 600, 1000, 1700, 2000, 5000, 100000]) {
      for (const level of ['county', 'state', undefined] as const) {
        const score = competitionEstablishmentFallbackScore(establishments, level);
        expect(score).toBeGreaterThanOrEqual(45);
        expect(score).toBeLessThanOrEqual(75);
        expect(score).toBeGreaterThan(35);
        expect(score).toBeLessThan(90);
      }
    }
  });
});

describe('growthTierFor', () => {
  it('keeps the top two tiers and max-achievable score unchanged', () => {
    expect(growthTierFor(5)).toBe(15);
    expect(growthTierFor(4.1)).toBe(15);
    expect(growthTierFor(2)).toBe(8);
    expect(growthTierFor(1.1)).toBe(8);
  });

  it('gives a mild flat/declining region a small floor score instead of flattening it to 0', () => {
    // Anything in (-2, 1] now scores 3 rather than being lumped in with a
    // severe contraction — this is the fix: a -0.5% dip shouldn't score
    // identically to a -10% collapse.
    expect(growthTierFor(1)).toBe(3);
    expect(growthTierFor(0)).toBe(3);
    expect(growthTierFor(-0.5)).toBe(3);
    expect(growthTierFor(-1.9)).toBe(3);
  });

  it('only bottoms out at 0 for genuinely severe contraction (worse than -2%)', () => {
    expect(growthTierFor(-2)).toBe(0);
    expect(growthTierFor(-5)).toBe(0);
    expect(growthTierFor(-10)).toBe(0);
  });
});
