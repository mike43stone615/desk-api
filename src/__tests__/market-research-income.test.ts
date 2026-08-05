import { describe, it, expect } from 'vitest';
import {
  deflateIncomeForRpp,
  incomeLevelTierFor,
  incomeEqualityTierFor,
  priceRelevanceMultiplier,
  incomeScoreFor,
  revenueIncomeTierFor,
  revenueIncomeScoreFor,
} from '../api/routes/integrations/market-research.js';

describe('deflateIncomeForRpp', () => {
  it('deflates nominal income down in a high-cost-of-living area (RPP > 100)', () => {
    // A regional price parity of 110 means the area is 10% more expensive
    // than the national average, so the same nominal dollars buy less —
    // real income should come out lower than nominal.
    expect(deflateIncomeForRpp(100000, 110)).toBeCloseTo(90909.09, 1);
  });

  it('inflates nominal income up in a low-cost-of-living area (RPP < 100)', () => {
    // RPP of 90 means the area is 10% cheaper than the national average, so
    // the same nominal dollars go further — real income should come out
    // higher than nominal.
    expect(deflateIncomeForRpp(100000, 90)).toBeCloseTo(111111.11, 1);
  });

  it('leaves income unchanged at exactly the national average (RPP = 100)', () => {
    expect(deflateIncomeForRpp(75000, 100)).toBe(75000);
  });

  it('falls back to nominal income unchanged when RPP is unavailable', () => {
    expect(deflateIncomeForRpp(65000, null)).toBe(65000);
    expect(deflateIncomeForRpp(65000, undefined)).toBe(65000);
  });

  it('falls back to nominal income unchanged when RPP is implausible (non-positive)', () => {
    expect(deflateIncomeForRpp(65000, 0)).toBe(65000);
    expect(deflateIncomeForRpp(65000, -5)).toBe(65000);
  });
});

describe('incomeLevelTierFor', () => {
  it('scores the same dollar breakpoints as the old flat tier, scaled to a 20-point max', () => {
    expect(incomeLevelTierFor(95000)).toBe(20);
    expect(incomeLevelTierFor(70000)).toBe(15);
    expect(incomeLevelTierFor(50000)).toBe(10);
    expect(incomeLevelTierFor(30000)).toBe(6);
  });

  it('never exceeds 20 regardless of how high real income is', () => {
    expect(incomeLevelTierFor(1_000_000)).toBe(20);
  });
});

describe('incomeEqualityTierFor', () => {
  it('scores the top tier for low (broad, equal) Gini values', () => {
    expect(incomeEqualityTierFor(0.35)).toBe(5);
    expect(incomeEqualityTierFor(0.399)).toBe(5);
  });

  it('scores the second tier for typical mid-size-city Gini values', () => {
    expect(incomeEqualityTierFor(0.4)).toBe(3);
    expect(incomeEqualityTierFor(0.449)).toBe(3);
  });

  it('scores the third tier for noticeably concentrated Gini values', () => {
    expect(incomeEqualityTierFor(0.45)).toBe(1);
    expect(incomeEqualityTierFor(0.499)).toBe(1);
  });

  it('scores zero for highly concentrated Gini values', () => {
    expect(incomeEqualityTierFor(0.5)).toBe(0);
    expect(incomeEqualityTierFor(0.55)).toBe(0);
  });

  it('scores zero (no bonus, not a floor/midpoint) when Gini is unavailable', () => {
    expect(incomeEqualityTierFor(null)).toBe(0);
    expect(incomeEqualityTierFor(undefined)).toBe(0);
  });
});

describe('priceRelevanceMultiplier', () => {
  it('scores up for premium/luxury-oriented pricing or target market language', () => {
    expect(
      priceRelevanceMultiplier('We plan to charge premium prices', ''),
    ).toEqual({ multiplier: 1.15, direction: 'premium' });
    expect(
      priceRelevanceMultiplier('', 'Upscale, boutique clientele'),
    ).toEqual({ multiplier: 1.15, direction: 'premium' });
    expect(
      priceRelevanceMultiplier('High-end custom furniture', ''),
    ).toEqual({ multiplier: 1.15, direction: 'premium' });
  });

  it('scores down for budget/value-oriented pricing or target market language', () => {
    expect(
      priceRelevanceMultiplier('Affordable pricing for everyone', ''),
    ).toEqual({ multiplier: 0.85, direction: 'budget' });
    expect(
      priceRelevanceMultiplier('', 'Budget-conscious families'),
    ).toEqual({ multiplier: 0.85, direction: 'budget' });
    expect(
      priceRelevanceMultiplier('Cheap, low-cost meal kits', ''),
    ).toEqual({ multiplier: 0.85, direction: 'budget' });
  });

  it('stays neutral when neither pattern matches', () => {
    expect(
      priceRelevanceMultiplier('Standard market pricing', 'General consumers'),
    ).toEqual({ multiplier: 1, direction: 'neutral' });
  });

  it('stays neutral when both patterns match (mixed/ambiguous signal)', () => {
    expect(
      priceRelevanceMultiplier(
        'Affordable pricing on our premium product line',
        '',
      ),
    ).toEqual({ multiplier: 1, direction: 'neutral' });
  });

  it('reads both pricingHypothesis and targetMarket combined', () => {
    expect(
      priceRelevanceMultiplier('Standard pricing', 'Luxury home buyers'),
    ).toEqual({ multiplier: 1.15, direction: 'premium' });
  });
});

describe('incomeScoreFor', () => {
  it('combines level + equality tiers and applies the price-relevance multiplier', () => {
    // realIncome = 100000 / (100/100) = 100000 -> level tier 20
    // gini 0.35 -> equality tier 5
    // base = 25, neutral multiplier -> 25
    const result = incomeScoreFor({
      nominalIncome: 100000,
      rpp: 100,
      gini: 0.35,
      pricingHypothesis: '',
      targetMarket: '',
    });
    expect(result.levelTier).toBe(20);
    expect(result.equalityTier).toBe(5);
    expect(result.multiplier).toBe(1);
    expect(result.score).toBe(25);
  });

  it('clamps the score to 25 even when a maxed-out premium case would otherwise exceed it', () => {
    // base = 20 + 5 = 25, premium multiplier 1.15 -> 28.75 -> rounds to 29,
    // which must be clamped back down to exactly 25.
    const result = incomeScoreFor({
      nominalIncome: 200000,
      rpp: 100,
      gini: 0.3,
      pricingHypothesis: 'Premium, high-end pricing',
      targetMarket: 'Luxury clientele',
    });
    expect(result.levelTier).toBe(20);
    expect(result.equalityTier).toBe(5);
    expect(result.multiplier).toBe(1.15);
    expect(result.score).toBe(25);
  });

  it('proves the maximum achievable Income contribution is exactly 25', () => {
    // The absolute best case across every sub-signal: top income-level
    // tier (COL-adjusted real income comfortably over the $90k breakpoint),
    // the best equality tier (Gini under 0.40), and the premium multiplier
    // — this must clamp to exactly 25, never above.
    const best = incomeScoreFor({
      nominalIncome: 500000,
      rpp: 80, // low-cost area inflates real income even further
      gini: 0.1, // maximally equal, far under the 0.40 top-tier cutoff
      pricingHypothesis: 'Exclusive, premium boutique pricing',
      targetMarket: 'Upscale, high-end luxury buyers',
    });
    expect(best.score).toBe(25);
  });

  it('scores down for a budget-oriented business even with strong income signals', () => {
    const result = incomeScoreFor({
      nominalIncome: 200000,
      rpp: 100,
      gini: 0.3,
      pricingHypothesis: 'Affordable, low-cost pricing',
      targetMarket: 'Budget-conscious shoppers',
    });
    expect(result.multiplier).toBe(0.85);
    // base 25 * 0.85 = 21.25 -> rounds to 21
    expect(result.score).toBe(21);
  });

  it('falls back to nominal income and a zero equality bonus when RPP/Gini are both unavailable', () => {
    const result = incomeScoreFor({
      nominalIncome: 50000,
      rpp: null,
      gini: null,
      pricingHypothesis: '',
      targetMarket: '',
    });
    expect(result.realIncome).toBe(50000);
    expect(result.levelTier).toBe(10);
    expect(result.equalityTier).toBe(0);
    expect(result.score).toBe(10);
  });

  it('never produces a negative score', () => {
    const result = incomeScoreFor({
      nominalIncome: 0,
      rpp: null,
      gini: 0.6,
      pricingHypothesis: 'cheap budget deals',
      targetMarket: '',
    });
    expect(result.score).toBeGreaterThanOrEqual(0);
  });
});

describe('revenueIncomeTierFor', () => {
  // Revenue's income signal deliberately stays nominal — no RPP deflation —
  // so it reuses the exact same dollar breakpoints the flat income tier has
  // always used, unlike incomeLevelTierFor which was rescaled to a 20-point
  // max when Demand's income score split into two sub-buckets.
  it('scores flat nominal-income tiers, not COL-adjusted', () => {
    expect(revenueIncomeTierFor(100000)).toBe(25);
    expect(revenueIncomeTierFor(60000)).toBe(17);
    expect(revenueIncomeTierFor(30000)).toBe(9);
  });

  it('never exceeds 25', () => {
    expect(revenueIncomeTierFor(10_000_000)).toBe(25);
  });
});

describe('revenueIncomeScoreFor', () => {
  it('applies no adjustment for neutral pricing/target-market text', () => {
    const result = revenueIncomeScoreFor({
      nominalIncome: 100000,
      pricingHypothesis: '',
      targetMarket: '',
    });
    expect(result.baseTier).toBe(25);
    expect(result.multiplier).toBe(1);
    expect(result.direction).toBe('neutral');
    expect(result.score).toBe(25);
  });

  it('reuses priceRelevanceMultiplier to score up for premium-oriented businesses', () => {
    const result = revenueIncomeScoreFor({
      nominalIncome: 60000,
      pricingHypothesis: 'Premium, high-end pricing',
      targetMarket: 'Luxury clientele',
    });
    expect(result.baseTier).toBe(17);
    expect(result.multiplier).toBe(1.15);
    expect(result.direction).toBe('premium');
    // 17 * 1.15 = 19.55 -> rounds to 20
    expect(result.score).toBe(20);
  });

  it('reuses priceRelevanceMultiplier to score down for budget-oriented businesses', () => {
    const result = revenueIncomeScoreFor({
      nominalIncome: 60000,
      pricingHypothesis: 'Affordable, low-cost pricing',
      targetMarket: 'Budget-conscious shoppers',
    });
    expect(result.baseTier).toBe(17);
    expect(result.multiplier).toBe(0.85);
    expect(result.direction).toBe('budget');
    // 17 * 0.85 = 14.45 -> rounds to 14
    expect(result.score).toBe(14);
  });

  it('clamps the score to 25 even when a maxed-out premium case would otherwise exceed it', () => {
    // base = 25 (top nominal-income tier), premium multiplier 1.15 -> 28.75
    // -> rounds to 29, which must be clamped back down to exactly 25.
    const result = revenueIncomeScoreFor({
      nominalIncome: 200000,
      pricingHypothesis: 'Exclusive, premium boutique pricing',
      targetMarket: 'Upscale, high-end luxury buyers',
    });
    expect(result.baseTier).toBe(25);
    expect(result.multiplier).toBe(1.15);
    expect(result.score).toBe(25);
  });

  it('never produces a negative score for a budget-oriented business with zero income', () => {
    const result = revenueIncomeScoreFor({
      nominalIncome: 0,
      pricingHypothesis: 'cheap budget deals',
      targetMarket: '',
    });
    expect(result.score).toBeGreaterThanOrEqual(0);
  });
});
