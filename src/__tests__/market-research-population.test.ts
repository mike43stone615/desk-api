import { describe, it, expect } from 'vitest';
import {
  populationTierFor,
  densityFor,
  populationDensityTierFor,
  ageFocusFor,
  ageAdjustmentMultiplier,
  populationScoreFor,
} from '../api/routes/integrations/market-research.js';

describe('densityFor', () => {
  it('converts population + land area (square meters) into people per square mile', () => {
    // Denver: population ~715k, AREALAND ~396,460,168 sq meters (~153 sq
    // mi, verified live against TIGERweb) -> roughly 4,673 people/sq mi.
    const density = densityFor(715000, 396460168);
    expect(density).not.toBeNull();
    expect(density as number).toBeGreaterThan(4000);
    expect(density as number).toBeLessThan(5000);
  });

  it('returns null (not 0) when land area is unavailable, so it can be skipped rather than penalized', () => {
    expect(densityFor(500000, null)).toBeNull();
    expect(densityFor(500000, undefined)).toBeNull();
    expect(densityFor(500000, 0)).toBeNull();
    expect(densityFor(500000, -1)).toBeNull();
  });
});

describe('populationDensityTierFor', () => {
  it('scores dense urban cores (>5,000/sq mi) at the 8-point max', () => {
    expect(populationDensityTierFor(5001)).toBe(8);
    expect(populationDensityTierFor(20000)).toBe(8);
  });

  it('scores car-dependent suburban density (1,000-5,000/sq mi) in the middle band', () => {
    expect(populationDensityTierFor(1001)).toBe(5);
    expect(populationDensityTierFor(4999)).toBe(5);
    expect(populationDensityTierFor(5000)).toBe(5); // boundary is exclusive on the high side
  });

  it('scores rural/exurban density (<=1,000/sq mi) at the floor', () => {
    expect(populationDensityTierFor(1000)).toBe(2); // boundary is exclusive on the low side too
    expect(populationDensityTierFor(500)).toBe(2);
    expect(populationDensityTierFor(0)).toBe(2);
  });

  it('contributes exactly 0 (not a penalty) when density is unavailable', () => {
    expect(populationDensityTierFor(null)).toBe(0);
  });

  it('never exceeds the 8-point max', () => {
    for (const density of [0, 500, 1000, 1001, 5000, 5001, 100000]) {
      expect(populationDensityTierFor(density)).toBeLessThanOrEqual(8);
    }
  });
});

describe('ageFocusFor', () => {
  it('detects a children/family-oriented idea from keywords', () => {
    expect(ageFocusFor('Childcare', 'A daycare center for toddlers')).toBe(
      'children',
    );
    expect(ageFocusFor('', 'An after-school tutoring program for kids')).toBe(
      'children',
    );
    expect(ageFocusFor('', 'A family-friendly indoor playground')).toBe(
      'children',
    );
  });

  it('detects a senior/retiree-oriented idea from keywords', () => {
    expect(ageFocusFor('', 'An assisted living facility for seniors')).toBe(
      'seniors',
    );
    expect(ageFocusFor('Retirement planning services', '')).toBe('seniors');
  });

  it('returns null for the common case of a generic idea with no age focus', () => {
    expect(ageFocusFor('Coffee shop', 'A specialty coffee shop downtown')).toBeNull();
    expect(
      ageFocusFor('Accounting', 'Bookkeeping services for small businesses'),
    ).toBeNull();
  });

  it('returns null (does not force a guess) when both children and senior keywords match', () => {
    expect(
      ageFocusFor('', 'A multi-generational family and senior day center'),
    ).toBeNull();
  });
});

describe('ageAdjustmentMultiplier', () => {
  it('returns exactly 1 (no adjustment) when there is no age focus', () => {
    expect(ageAdjustmentMultiplier(null, 0.4)).toBe(1);
  });

  it('returns exactly 1 when the ratio is unavailable even though a focus matched', () => {
    expect(ageAdjustmentMultiplier('children', null)).toBe(1);
  });

  it('returns 1 (no adjustment) exactly at the national baseline', () => {
    // Children baseline is ~25% under-18.
    expect(ageAdjustmentMultiplier('children', 0.25)).toBeCloseTo(1, 5);
    // Senior baseline is ~16% 65+.
    expect(ageAdjustmentMultiplier('seniors', 0.16)).toBeCloseTo(1, 5);
  });

  it('scores above 1 when the relevant age group is over-represented relative to baseline', () => {
    const multiplier = ageAdjustmentMultiplier('children', 0.4); // well above 25%
    expect(multiplier).toBeGreaterThan(1);
    expect(multiplier).toBeLessThanOrEqual(1.15);
  });

  it('scores below 1 when the relevant age group is under-represented relative to baseline', () => {
    const multiplier = ageAdjustmentMultiplier('children', 0.1); // well below 25%
    expect(multiplier).toBeLessThan(1);
    expect(multiplier).toBeGreaterThanOrEqual(0.85);
  });

  it('clamps at the 1.15 ceiling for an extreme ratio', () => {
    expect(ageAdjustmentMultiplier('children', 0.95)).toBe(1.15);
    expect(ageAdjustmentMultiplier('seniors', 0.9)).toBe(1.15);
  });

  it('clamps at the 0.85 floor for a near-zero ratio', () => {
    expect(ageAdjustmentMultiplier('children', 0.001)).toBe(0.85);
    expect(ageAdjustmentMultiplier('seniors', 0.001)).toBe(0.85);
  });

  it('is symmetric around baseline: double the baseline share and half the baseline share move the multiplier by the same amount in opposite directions', () => {
    const above = ageAdjustmentMultiplier('children', 0.5); // 2x the 0.25 baseline
    const below = ageAdjustmentMultiplier('children', 0.125); // 0.5x the 0.25 baseline
    expect(above - 1).toBeCloseTo(1 - below, 5);
  });
});

describe('populationScoreFor', () => {
  it('achieves the max achievable 40 when headcount, density, and age relevance all peak together', () => {
    const result = populationScoreFor({
      population: 500000,
      populationLevel: 'place', // headcount tier 32 (>150000 at place scale)
      areaLandSqMeters: 500000, // absurdly small area -> huge density -> tier 8
      ageFocus: 'children',
      ageRelevantSum: 475000, // 95% under 18 -> multiplier clamps at 1.15
    });
    expect(result.headcountTier).toBe(32);
    expect(result.densityTier).toBe(8);
    expect(result.ageMultiplier).toBe(1.15);
    // 32 * 1.15 = 36.8 -> rounds to 37, + 8 density = 45, clamped to 40.
    expect(result.score).toBe(40);
  });

  it('never exceeds 40 or drops below 0 regardless of the combination of sub-signals', () => {
    const populations = [0, 1000, 50000, 750000];
    const areas = [null, 100, 1000000, 500000000];
    const ratios = [null, 0, 0.01, 0.5, 0.99];
    for (const population of populations) {
      for (const areaLandSqMeters of areas) {
        for (const ageRelevantSum of ratios.map((r) =>
          r === null ? null : r * population,
        )) {
          const result = populationScoreFor({
            population,
            populationLevel: 'place',
            areaLandSqMeters,
            ageFocus: 'seniors',
            ageRelevantSum,
          });
          expect(result.score).toBeGreaterThanOrEqual(0);
          expect(result.score).toBeLessThanOrEqual(40);
        }
      }
    }
  });

  it('skips density gracefully (contributes 0) when area land is unavailable, e.g. geography only resolved to state level', () => {
    const result = populationScoreFor({
      population: 5000000,
      populationLevel: 'state',
      areaLandSqMeters: undefined,
      ageFocus: null,
      ageRelevantSum: null,
    });
    expect(result.density).toBeNull();
    expect(result.densityTier).toBe(0);
    expect(result.score).toBe(result.headcountTier);
  });

  it('applies no age adjustment (multiplier 1) for the common no-age-focus case', () => {
    const result = populationScoreFor({
      population: 100000,
      populationLevel: 'place',
      areaLandSqMeters: 50000000,
      ageFocus: null,
      ageRelevantSum: null,
    });
    expect(result.ageMultiplier).toBe(1);
    expect(result.ageRatio).toBeNull();
  });

  it('matches populationTierFor + populationDensityTierFor exactly when age focus is absent', () => {
    const population = 200000;
    const areaLandSqMeters = 260000000; // roughly 1,992 people/sq mi -> mid density tier
    const result = populationScoreFor({
      population,
      populationLevel: 'place',
      areaLandSqMeters,
      ageFocus: null,
      ageRelevantSum: null,
    });
    const expectedHeadcount = populationTierFor(population, 'place');
    const expectedDensity = populationDensityTierFor(
      densityFor(population, areaLandSqMeters),
    );
    expect(result.score).toBe(expectedHeadcount + expectedDensity);
  });
});
