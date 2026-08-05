import { describe, it, expect } from 'vitest';
import {
  populationTierFor,
  establishmentTierFor,
  nonemployerEstablishmentTierFor,
  receiptsTierFor,
  competitionEstablishmentFallbackScore,
  trendPoints,
  growthTierFor,
} from '../api/routes/integrations/market-research.js';

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
  it('uses the county-scale table when the level is "county"', () => {
    expect(receiptsTierFor(350000, 'county')).toBe(40);
    expect(receiptsTierFor(100000, 'county')).toBe(30);
    expect(receiptsTierFor(20000, 'county')).toBe(20);
    expect(receiptsTierFor(1000, 'county')).toBe(10);
  });

  it('uses the state-scale table when the level is "state" or unknown (no regression)', () => {
    for (const level of ['state', undefined] as const) {
      expect(receiptsTierFor(1200000, level)).toBe(40);
      expect(receiptsTierFor(300000, level)).toBe(30);
      expect(receiptsTierFor(60000, level)).toBe(20);
      expect(receiptsTierFor(1000, level)).toBe(10);
    }
  });
});

describe('competitionEstablishmentFallbackScore', () => {
  it('scores in the opposite direction of the demand establishment tier (more establishments = more crowded = lower score)', () => {
    expect(competitionEstablishmentFallbackScore(3000, 'state')).toBeLessThan(
      competitionEstablishmentFallbackScore(50, 'state'),
    );
    expect(competitionEstablishmentFallbackScore(700, 'county')).toBeLessThan(
      competitionEstablishmentFallbackScore(10, 'county'),
    );
  });

  it('uses county-scale thresholds proportioned below state-scale ones', () => {
    // 700 establishments reads as "very crowded" (lowest score) at county
    // scale but only lands in the middle state-scale bracket.
    expect(competitionEstablishmentFallbackScore(700, 'county')).toBe(45);
    expect(competitionEstablishmentFallbackScore(700, 'state')).toBe(60);
  });

  it('falls back to state-scale thresholds when the level is unknown (no regression)', () => {
    expect(competitionEstablishmentFallbackScore(2500, undefined)).toBe(45);
    expect(competitionEstablishmentFallbackScore(600, undefined)).toBe(60);
    expect(competitionEstablishmentFallbackScore(150, undefined)).toBe(75);
    expect(competitionEstablishmentFallbackScore(10, undefined)).toBe(65);
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
