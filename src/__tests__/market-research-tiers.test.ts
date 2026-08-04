import { describe, it, expect } from 'vitest';
import {
  populationTierFor,
  establishmentTierFor,
  receiptsTierFor,
  competitionEstablishmentFallbackScore,
} from '../api/routes/integrations/market-research.js';

describe('populationTierFor', () => {
  it('uses the city-scale table when the level is "place"', () => {
    // A city of 200k is well below the state-scale >500000 top tier, but
    // clears the city-scale >150000 top tier — this is exactly the
    // regression Task 1/2 exist to fix (real cities almost never clear
    // state-scale thresholds).
    expect(populationTierFor(200000, 'place')).toBe(40);
    expect(populationTierFor(60000, 'place')).toBe(30);
    expect(populationTierFor(12000, 'place')).toBe(20);
    expect(populationTierFor(5000, 'place')).toBe(10);
  });

  it('uses the county-scale table when the level is "county"', () => {
    expect(populationTierFor(350000, 'county')).toBe(40);
    expect(populationTierFor(80000, 'county')).toBe(30);
    expect(populationTierFor(20000, 'county')).toBe(20);
    expect(populationTierFor(5000, 'county')).toBe(10);
  });

  it('uses the original state-scale table when the level is "state"', () => {
    expect(populationTierFor(600000, 'state')).toBe(40);
    expect(populationTierFor(150000, 'state')).toBe(30);
    expect(populationTierFor(30000, 'state')).toBe(20);
    expect(populationTierFor(1000, 'state')).toBe(10);
  });

  it('falls back to the state-scale table (unchanged behavior) when no geography level is known', () => {
    // This is the no-regression case: a request where geography resolution
    // failed entirely must score exactly as it did before this change.
    expect(populationTierFor(600000, undefined)).toBe(40);
    expect(populationTierFor(150000, undefined)).toBe(30);
    expect(populationTierFor(30000, undefined)).toBe(20);
    expect(populationTierFor(1000, undefined)).toBe(10);
  });

  it('scores a real mid-size city fairly at place level but poorly at state level', () => {
    // Denver's ~713k population would land in the second-from-top state
    // tier if (incorrectly) compared against state-scale thresholds, but
    // should hit the max tier at city scale.
    const cityScore = populationTierFor(713000, 'place');
    const stateScaleComparison = populationTierFor(713000, 'state');
    expect(cityScore).toBe(40);
    expect(stateScaleComparison).toBe(40);
    // A smaller but still substantial city (60k) illustrates the actual
    // fix: city scale correctly recognizes it as strong demand, state
    // scale would bottom it out.
    expect(populationTierFor(60000, 'place')).toBeGreaterThan(
      populationTierFor(60000, 'state'),
    );
  });
});

describe('establishmentTierFor', () => {
  it('uses the county-scale table when the level is "county"', () => {
    expect(establishmentTierFor(350, 'county')).toBe(20);
    expect(establishmentTierFor(100, 'county')).toBe(15);
    expect(establishmentTierFor(25, 'county')).toBe(10);
    expect(establishmentTierFor(5, 'county')).toBe(5);
  });

  it('uses the state-scale table when the level is "state" or unknown (no regression)', () => {
    for (const level of ['state', undefined] as const) {
      expect(establishmentTierFor(1200, level)).toBe(20);
      expect(establishmentTierFor(300, level)).toBe(15);
      expect(establishmentTierFor(60, level)).toBe(10);
      expect(establishmentTierFor(10, level)).toBe(5);
    }
  });

  it('county-scale thresholds are lower than state-scale (a county has fewer establishments than its state)', () => {
    // The same raw establishment count should never score worse at county
    // scale than it would at state scale.
    for (const count of [10, 30, 80, 400]) {
      expect(establishmentTierFor(count, 'county')).toBeGreaterThanOrEqual(
        establishmentTierFor(count, 'state'),
      );
    }
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
