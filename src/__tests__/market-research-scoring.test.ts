import { describe, it, expect } from 'vitest';
import {
  computeRegulatoryFrictionScore,
  scoreStartupDifficulty,
  capitalPointsFor,
  productPointsFor,
  barrierPointsFor,
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
    // capital(low-capital NAICS base 20 + confirmed-zero bond/insurance
    // modifier +5 = 25) + barrier(unlicensed/B2C, 15) +
    // product(non-physical, 20) + labor(unemployment > 6%, 20) +
    // knowledge(unlicensed, 10) + licensing(requirementCount < 5, 10) = 100.
    const result = scoreStartupDifficulty({
      industry: 'Software Consulting',
      businessIdea: 'general software consulting for small businesses',
      naicsCodes: ['54'],
      customerType: 'B2C',
      unemploymentRate: 10,
      requirementCount: 2,
      bondOrInsuranceCount: 0,
    });
    expect(result.score).toBe(100);
  });

  it('ranks reasons with the largest point contributor first', () => {
    // Capital-intensive (base 4 pts, no bond/insurance data so a neutral
    // +0 modifier, lowest of the six signals) vs. barrier (15 pts, the max
    // for a non-licensed B2C business) — barrier should lead the ranked
    // reasons, capital should trail.
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

  it('does not let missing bond/insurance data crash or dominate the score, and gives it a neutral contribution', () => {
    const result = scoreStartupDifficulty({
      industry: 'Software Consulting',
      businessIdea: 'general software consulting for small businesses',
      naicsCodes: ['54'],
      customerType: 'B2C',
      unemploymentRate: 5,
      requirementCount: 2,
      bondOrInsuranceCount: undefined,
    });
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    // Low-capital NAICS base (20) + neutral missing-data modifier (0) = 20,
    // not the full 25 a confirmed-zero count would earn.
    expect(capitalPointsFor(['54'], undefined)).toBe(20);
  });

  it('lets a confirmed zero bond/insurance count score higher than a missing count, which in turn scores higher than several stacked requirements', () => {
    const base = {
      industry: 'Software Consulting',
      businessIdea: 'general software consulting for small businesses',
      naicsCodes: ['54'],
      customerType: 'B2C',
      unemploymentRate: 5,
      requirementCount: 2,
    };
    const confirmedNone = scoreStartupDifficulty({
      ...base,
      bondOrInsuranceCount: 0,
    });
    const missingData = scoreStartupDifficulty({
      ...base,
      bondOrInsuranceCount: undefined,
    });
    const heavyBondInsurance = scoreStartupDifficulty({
      ...base,
      bondOrInsuranceCount: 4,
    });
    expect(confirmedNone.score).toBeGreaterThan(missingData.score);
    expect(missingData.score).toBeGreaterThan(heavyBondInsurance.score);
    expect(
      heavyBondInsurance.reasons.join(' ').toLowerCase(),
    ).toContain('4 bond/insurance requirements');
  });

  it('prefers the real Compliance-OS license/registration count over the LICENSED_TRADE_PATTERN guess when both are available', () => {
    // "Concrete Contractor" matches LICENSED_TRADE_PATTERN, but a confirmed
    // zero from Compliance-OS should override that guess and score the
    // credential factor as if it were unlicensed.
    const regexSaysLicensedRealDataSaysNot = scoreStartupDifficulty({
      industry: 'Concrete Contractor',
      businessIdea: 'concrete contractor serving residential customers',
      naicsCodes: ['23'],
      customerType: 'B2C',
      unemploymentRate: 5,
      licenseOrRegistrationCount: 0,
    });
    const regexOnlyUnlicensed = scoreStartupDifficulty({
      industry: 'Virtual Assistant Services',
      businessIdea: 'remote administrative support',
      naicsCodes: ['23'],
      customerType: 'B2C',
      unemploymentRate: 5,
    });
    const barrierReasonA = regexSaysLicensedRealDataSaysNot.reasons.find((r) =>
      r.toLowerCase().includes('barrier'),
    );
    const barrierReasonB = regexOnlyUnlicensed.reasons.find((r) =>
      r.toLowerCase().includes('barrier'),
    );
    // Both should land on the same "low" credential read once the real
    // zero-count data is in play, and the note should cite Compliance-OS
    // rather than the keyword guess.
    expect(barrierReasonA?.toLowerCase()).toContain('compliance-os found no license');
    expect(barrierReasonB?.toLowerCase()).toContain("doesn't look like a licensed");
  });

  it('falls back to the LICENSED_TRADE_PATTERN guess when no real license/registration data is available', () => {
    const result = scoreStartupDifficulty({
      industry: 'Concrete Contractor',
      businessIdea: 'concrete contractor serving commercial developers',
      naicsCodes: ['23'],
      customerType: 'B2C',
      unemploymentRate: 5,
      licenseOrRegistrationCount: undefined,
    });
    const barrierReason = result.reasons.find((r) =>
      r.toLowerCase().includes('barrier'),
    );
    expect(barrierReason?.toLowerCase()).toContain('based on the business description');
  });
});

describe('barrierPointsFor', () => {
  it('maxes out at exactly 15 for an unlicensed, B2C business with a light compliance load', () => {
    expect(
      barrierPointsFor({
        isLicensedTrade: false,
        isB2B: false,
        licenseOrRegistrationCount: 0,
        requirementCount: 0,
      }),
    ).toBe(15);
  });

  it('never exceeds the 0-15 range regardless of inputs', () => {
    const bools = [true, false];
    const counts = [0, 1, 2, 5, undefined];
    for (const isLicensedTrade of bools) {
      for (const isB2B of bools) {
        for (const licenseOrRegistrationCount of counts) {
          for (const requirementCount of counts) {
            const points = barrierPointsFor({
              isLicensedTrade,
              isB2B,
              licenseOrRegistrationCount,
              requirementCount,
            });
            expect(points).toBeGreaterThanOrEqual(0);
            expect(points).toBeLessThanOrEqual(15);
          }
        }
      }
    }
  });

  it('uses the real Compliance-OS license/registration count as the primary credential signal when available', () => {
    const noRequirement = barrierPointsFor({
      isLicensedTrade: false,
      isB2B: false,
      licenseOrRegistrationCount: 0,
      requirementCount: undefined,
    });
    const oneRequirement = barrierPointsFor({
      isLicensedTrade: false,
      isB2B: false,
      licenseOrRegistrationCount: 1,
      requirementCount: undefined,
    });
    const twoRequirements = barrierPointsFor({
      isLicensedTrade: false,
      isB2B: false,
      licenseOrRegistrationCount: 2,
      requirementCount: undefined,
    });
    expect(noRequirement).toBeGreaterThan(oneRequirement);
    expect(oneRequirement).toBeGreaterThan(twoRequirements);
  });

  it('lets real Compliance-OS data override an incorrect LICENSED_TRADE_PATTERN guess in either direction', () => {
    // Regex says licensed, real data confirms zero matched requirements —
    // should score the same as a case that never looked licensed at all.
    const regexWrongPositive = barrierPointsFor({
      isLicensedTrade: true,
      isB2B: false,
      licenseOrRegistrationCount: 0,
      requirementCount: undefined,
    });
    const genuinelyUnlicensed = barrierPointsFor({
      isLicensedTrade: false,
      isB2B: false,
      licenseOrRegistrationCount: 0,
      requirementCount: undefined,
    });
    expect(regexWrongPositive).toBe(genuinelyUnlicensed);

    // Regex says unlicensed, real data finds matched requirements — should
    // score the same as a case the regex correctly flagged.
    const regexWrongNegative = barrierPointsFor({
      isLicensedTrade: false,
      isB2B: false,
      licenseOrRegistrationCount: 2,
      requirementCount: undefined,
    });
    const genuinelyLicensed = barrierPointsFor({
      isLicensedTrade: true,
      isB2B: false,
      licenseOrRegistrationCount: 2,
      requirementCount: undefined,
    });
    expect(regexWrongNegative).toBe(genuinelyLicensed);
  });

  it('falls back to the LICENSED_TRADE_PATTERN guess (binary) only when real license/registration data is unavailable', () => {
    const unlicensedGuess = barrierPointsFor({
      isLicensedTrade: false,
      isB2B: false,
      licenseOrRegistrationCount: undefined,
      requirementCount: undefined,
    });
    const licensedGuess = barrierPointsFor({
      isLicensedTrade: true,
      isB2B: false,
      licenseOrRegistrationCount: undefined,
      requirementCount: undefined,
    });
    expect(unlicensedGuess).toBeGreaterThan(licensedGuess);
  });

  it('applies a bigger B2B penalty when B2B compounds with a real licensing signal than when B2B stands alone', () => {
    const b2cUnlicensed = barrierPointsFor({
      isLicensedTrade: false,
      isB2B: false,
      licenseOrRegistrationCount: 0,
      requirementCount: undefined,
    });
    const b2cLicensed = barrierPointsFor({
      isLicensedTrade: false,
      isB2B: false,
      licenseOrRegistrationCount: 2,
      requirementCount: undefined,
    });
    const b2bUnlicensed = barrierPointsFor({
      isLicensedTrade: false,
      isB2B: true,
      licenseOrRegistrationCount: 0,
      requirementCount: undefined,
    });
    const b2bLicensed = barrierPointsFor({
      isLicensedTrade: false,
      isB2B: true,
      licenseOrRegistrationCount: 2,
      requirementCount: undefined,
    });
    // The credential-only drop (B2C unlicensed -> B2C licensed) shouldn't be
    // as large as the combined drop when the same credential shift also
    // compounds with B2B (B2B unlicensed -> B2B licensed) — otherwise B2B
    // would just be an unconditional flat penalty independent of licensing,
    // exactly what this redesign moves away from.
    const creditOnlyDrop = b2cUnlicensed - b2cLicensed;
    const compoundedDrop = b2bUnlicensed - b2bLicensed;
    expect(compoundedDrop).toBeGreaterThan(creditOnlyDrop);
  });

  it('lets a genuinely-easy case score meaningfully above a merely-average case that used to cap out identically at 15', () => {
    // Under the old flat model, both of these (unlicensed, B2C) scored an
    // identical flat 15 regardless of overall compliance load. Now they
    // should differ by a real margin.
    const genuinelyEasy = barrierPointsFor({
      isLicensedTrade: false,
      isB2B: false,
      licenseOrRegistrationCount: undefined,
      requirementCount: 0,
    });
    const merelyAverage = barrierPointsFor({
      isLicensedTrade: false,
      isB2B: false,
      licenseOrRegistrationCount: undefined,
      requirementCount: 6,
    });
    expect(genuinelyEasy).toBe(15);
    expect(genuinelyEasy - merelyAverage).toBeGreaterThanOrEqual(3);
  });
});

describe('capitalPointsFor', () => {
  it('maxes out at exactly 25 for a low-capital NAICS code with a confirmed-zero bond/insurance count', () => {
    expect(capitalPointsFor(['54'], 0)).toBe(25);
    expect(capitalPointsFor(['61'], 0)).toBe(25);
    expect(capitalPointsFor(['52'], 0)).toBe(25);
  });

  it('never exceeds 25 regardless of NAICS code or bond/insurance count', () => {
    const naicsCodes = [
      '23', '31-33', '72', '44', '48', '62', '54', '61', '52', '53',
    ];
    const bondCounts = [0, 1, 2, 3, 10, undefined];
    for (const code of naicsCodes) {
      for (const count of bondCounts) {
        const points = capitalPointsFor([code], count);
        expect(points).toBeGreaterThanOrEqual(0);
        expect(points).toBeLessThanOrEqual(25);
      }
    }
  });

  it('scores the newly-classified high-capital sectors (transportation/warehousing) the same as the pre-existing high-capital tier', () => {
    // 48 (Transportation & Warehousing) is a new explicit entry — it should
    // land in the same HIGH base tier as the pre-existing capital-intensive
    // codes (23 construction, 31-33 manufacturing, 72 food service, 44
    // retail), not fall through to the generic moderate default.
    expect(capitalPointsFor(['48'], undefined)).toBe(
      capitalPointsFor(['23'], undefined),
    );
    expect(capitalPointsFor(['48'], undefined)).toBe(4);
  });

  it('scores the newly-classified moderate-high sector (health care) strictly between the high and low tiers', () => {
    // 62 (Health Care & Social Assistance) is a new intermediate tier — real
    // equipment/facility needs, but typically lighter than construction or
    // manufacturing, and heavier than a pure knowledge/services business.
    const highCapital = capitalPointsFor(['23'], undefined);
    const moderateHighCapital = capitalPointsFor(['62'], undefined);
    const lowCapital = capitalPointsFor(['54'], undefined);
    expect(moderateHighCapital).toBeGreaterThan(highCapital);
    expect(moderateHighCapital).toBeLessThan(lowCapital);
    expect(moderateHighCapital).toBe(8);
  });

  it('falls through unlisted codes (e.g. 53 real estate/rental) to the generic moderate default rather than guessing', () => {
    // 53 spans a licensed agent (low capital) to a business that buys and
    // holds property to lease out (high capital) — deliberately no
    // dedicated tier, so it should land strictly between the high and low
    // tiers, distinct from both.
    const highCapital = capitalPointsFor(['23'], undefined);
    const lowCapital = capitalPointsFor(['54'], undefined);
    const realEstate = capitalPointsFor(['53'], undefined);
    expect(realEstate).toBeGreaterThan(highCapital);
    expect(realEstate).toBeLessThan(lowCapital);
    expect(realEstate).toBe(12);
  });

  it('picks the more capital-intensive of two codes for a compound business idea', () => {
    // A vertically-integrated business that both manufactures (31-33, HIGH)
    // and sells professional services (54, LOW) should be scored as
    // capital-intensive — the same conservative "assume the harder case"
    // priority the old flat lookup used.
    expect(capitalPointsFor(['54', '31-33'], undefined)).toBe(
      capitalPointsFor(['31-33'], undefined),
    );
  });
});

describe('productPointsFor', () => {
  it('scores the high build-complexity sectors (construction, manufacturing, transportation) at the bottom tier', () => {
    expect(productPointsFor(['23'])).toBe(6);
    expect(productPointsFor(['31-33'])).toBe(6);
    expect(productPointsFor(['48'])).toBe(6);
  });

  it('scores the moderate-high build-complexity sectors (food service, health care) strictly between high and moderate', () => {
    const high = productPointsFor(['23']);
    const moderateHighFood = productPointsFor(['72']);
    const moderateHighHealth = productPointsFor(['62']);
    const moderate = productPointsFor(['44']);
    expect(moderateHighFood).toBeGreaterThan(high);
    expect(moderateHighFood).toBeLessThan(moderate);
    expect(moderateHighHealth).toBeGreaterThan(high);
    expect(moderateHighHealth).toBeLessThan(moderate);
    expect(moderateHighFood).toBe(10);
    expect(moderateHighHealth).toBe(10);
  });

  it('scores retail as a distinct moderate tier, no longer lumped into the old binary "easy" bucket', () => {
    // Under the old binary check, only NAICS 23/31-33 scored low and
    // literally everything else (including retail) maxed out at 20. Retail
    // has real (if lighter) build complexity — fixtures, inventory, a POS
    // system — so it must land strictly below the low-complexity ceiling.
    const retail = productPointsFor(['44']);
    const low = productPointsFor(['54']);
    expect(retail).toBe(14);
    expect(retail).toBeLessThan(low);
  });

  it('scores food service as a distinct moderate-high tier, no longer lumped into the old binary "easy" bucket', () => {
    const foodService = productPointsFor(['72']);
    const low = productPointsFor(['54']);
    expect(foodService).toBeLessThan(low);
    expect(foodService).toBeLessThan(productPointsFor(['44']));
  });

  it('falls through unlisted codes (e.g. 53 real estate/rental) to the generic moderate default', () => {
    const high = productPointsFor(['23']);
    const low = productPointsFor(['54']);
    const realEstate = productPointsFor(['53']);
    expect(realEstate).toBeGreaterThan(high);
    expect(realEstate).toBeLessThan(low);
    expect(realEstate).toBe(14);
  });

  it('maxes out at exactly 20 for pure professional/knowledge sectors', () => {
    expect(productPointsFor(['54'])).toBe(20);
    expect(productPointsFor(['61'])).toBe(20);
    expect(productPointsFor(['52'])).toBe(20);
  });

  it('never exceeds the 0-20 range regardless of NAICS code', () => {
    const naicsCodes = ['23', '31-33', '72', '44', '48', '62', '54', '61', '52', '53'];
    for (const code of naicsCodes) {
      const points = productPointsFor([code]);
      expect(points).toBeGreaterThanOrEqual(0);
      expect(points).toBeLessThanOrEqual(20);
    }
  });

  it('picks the more build-complex of two codes for a compound business idea', () => {
    // A business idea that reads as both professional services (54, LOW
    // build complexity) and construction (23, HIGH) should be scored as
    // build-complex — same conservative "assume the harder case" priority
    // naicsCapitalBaseFor uses.
    expect(productPointsFor(['54', '23'])).toBe(productPointsFor(['23']));
  });

  it('produces four genuinely distinct tiers, not a binary split', () => {
    const values = new Set([
      productPointsFor(['23']),
      productPointsFor(['72']),
      productPointsFor(['44']),
      productPointsFor(['54']),
    ]);
    expect(values.size).toBe(4);
  });
});
