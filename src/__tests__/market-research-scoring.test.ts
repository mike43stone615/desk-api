import { describe, it, expect } from 'vitest';
import {
  computeRegulatoryFrictionScore,
  scoreStartupDifficulty,
} from '../api/routes/integrations/market-research.js';

describe('computeRegulatoryFrictionScore', () => {
  it('scores high (low friction) when there are no known requirements', () => {
    expect(computeRegulatoryFrictionScore([])).toBeGreaterThanOrEqual(85);
  });

  it('scores a handful of recommended-only requirements as light friction', () => {
    const score = computeRegulatoryFrictionScore([
      { category: 'REGISTRATION', severity: 'RECOMMENDED', renewalFrequency: null },
      { category: 'FILING', severity: 'RECOMMENDED', renewalFrequency: null },
    ]);
    expect(score).toBeGreaterThanOrEqual(80);
  });

  it('scores many mandatory, recurring requirements as heavy friction', () => {
    const heavy = Array.from({ length: 12 }, () => ({
      category: 'LICENSE',
      severity: 'MANDATORY',
      renewalFrequency: 'ANNUAL',
    }));
    expect(computeRegulatoryFrictionScore(heavy)).toBeLessThanOrEqual(20);
  });

  it('weighs mandatory requirements more heavily than conditional ones', () => {
    const mandatory = computeRegulatoryFrictionScore([
      { category: 'LICENSE', severity: 'MANDATORY', renewalFrequency: null },
    ]);
    const conditional = computeRegulatoryFrictionScore([
      { category: 'LICENSE', severity: 'CONDITIONAL', renewalFrequency: null },
    ]);
    expect(mandatory).toBeLessThan(conditional);
  });

  it('adds friction for a requirement that recurs on a renewal schedule', () => {
    const oneTime = computeRegulatoryFrictionScore([
      { category: 'FILING', severity: 'MANDATORY', renewalFrequency: null },
    ]);
    const recurring = computeRegulatoryFrictionScore([
      { category: 'FILING', severity: 'MANDATORY', renewalFrequency: 'ANNUAL' },
    ]);
    expect(recurring).toBeLessThan(oneTime);
  });
});

describe('scoreStartupDifficulty', () => {
  it('scores a low-capital, unlicensed, B2C service idea as easy to start', () => {
    const result = scoreStartupDifficulty({
      industry: 'Virtual Assistant Services',
      businessIdea: 'remote administrative support for solo entrepreneurs',
      naicsCodes: ['54'],
      customerType: 'B2C',
      unemploymentRate: 6,
    });
    expect(result.score).toBeGreaterThanOrEqual(75);
  });

  it('scores a capital-intensive, licensed, B2B trade as hard to start', () => {
    const result = scoreStartupDifficulty({
      industry: 'Concrete Contractor',
      businessIdea: 'concrete contractor serving commercial developers',
      naicsCodes: ['23'],
      customerType: 'B2B',
      unemploymentRate: 2,
    });
    expect(result.score).toBeLessThanOrEqual(40);
  });

  it('does not let missing unemployment data crash or dominate the score', () => {
    const result = scoreStartupDifficulty({
      industry: 'Consulting',
      businessIdea: 'general business consulting',
      naicsCodes: ['54'],
      customerType: 'B2B',
      unemploymentRate: undefined,
    });
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.reasons.join(' ')).toContain('unavailable');
  });

  it('does not let a missing requirement count crash or dominate the score, and gives it a neutral contribution', () => {
    const result = scoreStartupDifficulty({
      industry: 'Consulting',
      businessIdea: 'general business consulting',
      naicsCodes: ['54'],
      customerType: 'B2C',
      unemploymentRate: 5,
      requirementCount: undefined,
    });
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.reasons.join(' ')).toContain('unavailable');
  });

  it('blends in the real Compliance-OS requirement count as a licensing-complexity signal', () => {
    // Same capital/barrier/product/labor inputs throughout — only
    // requirementCount changes — so any score difference is attributable
    // to the new licensing-complexity bucket.
    const lightlyRegulated = scoreStartupDifficulty({
      industry: 'Consulting',
      businessIdea: 'general business consulting',
      naicsCodes: ['54'],
      customerType: 'B2C',
      unemploymentRate: 5,
      requirementCount: 2,
    });
    const heavilyRegulated = scoreStartupDifficulty({
      industry: 'Consulting',
      businessIdea: 'general business consulting',
      naicsCodes: ['54'],
      customerType: 'B2C',
      unemploymentRate: 5,
      requirementCount: 15,
    });
    expect(lightlyRegulated.score).toBeGreaterThan(heavilyRegulated.score);
    expect(heavilyRegulated.reasons.join(' ')).toContain('15 known requirements');
  });

  it('reaches exactly 100 when every signal, including the new licensing-complexity bucket, is maxed', () => {
    // capital(low-capital NAICS, 25) + barrier(unlicensed/B2C, 15) +
    // product(non-physical, 20) + labor(unemployment > 6%, 20) +
    // knowledge(unlicensed, 10) + licensing(requirementCount < 5, 10) = 100.
    const result = scoreStartupDifficulty({
      industry: 'Software Consulting',
      businessIdea: 'general software consulting for small businesses',
      naicsCodes: ['54'],
      customerType: 'B2C',
      unemploymentRate: 10,
      requirementCount: 2,
    });
    expect(result.score).toBe(100);
  });

  it('ranks reasons with the largest point contributor first', () => {
    // Capital-intensive (5 pts, lowest of the six signals) vs. barrier
    // (15 pts, the max for a non-licensed B2C business) — barrier should
    // lead the ranked reasons, capital should trail.
    const result = scoreStartupDifficulty({
      industry: 'Manufacturing',
      businessIdea: 'small-batch furniture manufacturing',
      naicsCodes: ['31-33'],
      customerType: 'B2C',
      unemploymentRate: 5,
      requirementCount: 2,
    });
    const barrierIndex = result.reasons.findIndex((r) =>
      r.toLowerCase().includes('barrier'),
    );
    const capitalIndex = result.reasons.findIndex((r) =>
      r.toLowerCase().includes('capital'),
    );
    expect(barrierIndex).toBeGreaterThanOrEqual(0);
    expect(capitalIndex).toBeGreaterThanOrEqual(0);
    expect(barrierIndex).toBeLessThan(capitalIndex);
    expect(result.reasons.length).toBe(6);
  });
});
