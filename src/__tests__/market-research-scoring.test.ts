import { describe, it, expect } from 'vitest';
import {
  computeRegulatoryFrictionScore,
  scoreStartupDifficulty,
  capitalPointsFor,
  productPointsFor,
  barrierPointsFor,
  laborPointsFor,
  knowledgePointsFor,
  licensingComplexityPointsFor,
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

  it('blends in the real Compliance-OS LICENSE-category composition as a licensing-complexity signal distinct from the flat requirement count', () => {
    // Same requirementCount (6) throughout, so barrierPoints' compliance-
    // breadth signal (which only looks at the flat count) contributes
    // identically in both cases — only licenseCount changes, so any score
    // difference here is attributable to the composition-aware licensing-
    // complexity signal, proving it reads something breadth doesn't.
    const base = {
      industry: 'Consulting',
      businessIdea: 'general business consulting',
      naicsCodes: ['54'],
      customerType: 'B2C' as const,
      unemploymentRate: 5,
      requirementCount: 6,
    };
    const licenseHeavy = scoreStartupDifficulty({ ...base, licenseCount: 5 });
    const registrationHeavy = scoreStartupDifficulty({ ...base, licenseCount: 0 });
    expect(registrationHeavy.score).toBeGreaterThan(licenseHeavy.score);

    const licensingReason = licenseHeavy.reasons.find((r) =>
      r.toLowerCase().includes('licenses requiring credentials'),
    );
    expect(licensingReason?.toLowerCase()).toContain('5 of 6 known requirement');
  });

  it('falls back to the flat requirementCount tiers for licensing-complexity when licenseCount is unavailable, even though composition-level tests above show a different score is possible', () => {
    const result = scoreStartupDifficulty({
      industry: 'Consulting',
      businessIdea: 'general business consulting',
      naicsCodes: ['54'],
      customerType: 'B2C',
      unemploymentRate: 5,
      requirementCount: 6,
      licenseCount: undefined,
    });
    const licensingReason = result.reasons.find((r) =>
      r.toLowerCase().includes('moderate licensing/permitting load'),
    );
    expect(licensingReason).toBeDefined();
  });

  it('reaches exactly 92 when every signal, including the new licensing-complexity bucket, is maxed for a labor-light, knowledge-intensive sector', () => {
    // capital(low-capital NAICS base 20 + confirmed-zero bond/insurance
    // modifier +5 = 25) + barrier(unlicensed/B2C, 15) +
    // product(non-physical, 20) + labor(20 snapshot for unemployment > 6%,
    // no trend data so no modifier, then blended 50% toward the neutral
    // midpoint of 10 because NAICS 54 is labor-light -> round(20*0.5 +
    // 10*0.5) = 15) + knowledge(unlicensed credential component 6 + NAICS
    // 54 knowledge-intensive component 1 = 7) +
    // licensing(requirementCount < 5, 10) = 92.
    //
    // NAICS 54/61/52 are simultaneously capitalPointsFor's LOW-capital tier,
    // laborPointsFor's labor-light tier (laborPointsFor deliberately reuses
    // the same NAICS_CAPITAL_LOW set — see its comment), AND
    // knowledgePointsFor's knowledge-intensive tier (knowledgePointsFor
    // deliberately reuses productPointsFor's NAICS_BUILD_LOW set — see its
    // comment). A business idea that maxes out capital/product via one of
    // those codes can therefore no longer also max out labor OR knowledge
    // the way it could before the labor-intensity blend and the NAICS
    // knowledge-intensity signal were added — the true achievable maximum
    // for this exact input shape is 92, not 100 (previously 95, before
    // knowledgePoints stopped treating "unlicensed" as sufficient on its
    // own for the full 10).
    const result = scoreStartupDifficulty({
      industry: 'Software Consulting',
      businessIdea: 'general software consulting for small businesses',
      naicsCodes: ['54'],
      customerType: 'B2C',
      unemploymentRate: 10,
      requirementCount: 2,
      bondOrInsuranceCount: 0,
    });
    expect(result.score).toBe(92);
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

  describe('subSignals', () => {
    it('returns one structured sub-signal per underlying sub-computation, summing to the total score', () => {
      const result = scoreStartupDifficulty({
        industry: 'Concrete Contractor',
        businessIdea: 'concrete contractor serving commercial developers',
        naicsCodes: ['23'],
        customerType: 'B2B',
        unemploymentRate: 4,
        requirementCount: 6,
        bondOrInsuranceCount: 2,
        licenseOrRegistrationCount: 3,
        licenseCount: 2,
      });
      const labels = result.subSignals.map((s) => s.label);
      expect(labels).toEqual([
        'Capital requirements',
        'Barrier to entry',
        'Product/build complexity',
        'Labor market tightness',
        'Knowledge intensity',
        'Licensing complexity',
      ]);
      const maxScores = result.subSignals.map((s) => s.maxScore);
      expect(maxScores).toEqual([25, 15, 20, 20, 10, 10]);
      expect(maxScores.reduce((a, b) => a + b, 0)).toBe(100);
      const totalSubSignalScore = result.subSignals.reduce((a, s) => a + s.score, 0);
      expect(totalSubSignalScore).toBe(result.score);
      for (const sub of result.subSignals) {
        expect(sub.score).toBeGreaterThanOrEqual(0);
        expect(sub.score).toBeLessThanOrEqual(sub.maxScore);
        expect(sub.rawValue.length).toBeGreaterThan(0);
        expect(sub.meaning.length).toBeGreaterThan(0);
        expect(sub.computation.length).toBeGreaterThan(0);
        expect(sub.source.length).toBeGreaterThan(0);
        expect(['strong', 'medium', 'limited']).toContain(sub.quality);
      }
    });

    it('marks Compliance-OS-backed sub-signals as strong quality only when real data is present', () => {
      const withData = scoreStartupDifficulty({
        industry: 'Consulting',
        businessIdea: 'general business consulting',
        naicsCodes: ['54'],
        customerType: 'B2C',
        unemploymentRate: 5,
        bondOrInsuranceCount: 0,
        licenseOrRegistrationCount: 0,
      });
      const withoutData = scoreStartupDifficulty({
        industry: 'Consulting',
        businessIdea: 'general business consulting',
        naicsCodes: ['54'],
        customerType: 'B2C',
        unemploymentRate: 5,
      });
      const capitalWith = withData.subSignals.find((s) => s.label === 'Capital requirements');
      const capitalWithout = withoutData.subSignals.find((s) => s.label === 'Capital requirements');
      expect(capitalWith?.quality).toBe('strong');
      expect(capitalWithout?.quality).toBe('limited');
    });
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

describe('knowledgePointsFor', () => {
  it('maxes out at exactly 10 for an unlicensed business in a non-knowledge-intensive sector', () => {
    expect(
      knowledgePointsFor({
        isLicensedTrade: false,
        licenseOrRegistrationCount: 0,
        naicsCodes: ['44'],
      }),
    ).toBe(10);
  });

  it('bottoms out at exactly 2 for a licensed business in a knowledge-intensive sector', () => {
    expect(
      knowledgePointsFor({
        isLicensedTrade: true,
        licenseOrRegistrationCount: 2,
        naicsCodes: ['54'],
      }),
    ).toBe(2);
  });

  it('never exceeds the 0-10 range regardless of inputs', () => {
    const bools = [true, false];
    const counts = [0, 1, 2, 5, undefined];
    const naicsCodes = [
      ['23'], ['31-33'], ['72'], ['44'], ['48'], ['62'], ['54'], ['61'], ['52'], ['53'],
    ];
    for (const isLicensedTrade of bools) {
      for (const licenseOrRegistrationCount of counts) {
        for (const codes of naicsCodes) {
          const points = knowledgePointsFor({
            isLicensedTrade,
            licenseOrRegistrationCount,
            naicsCodes: codes,
          });
          expect(points).toBeGreaterThanOrEqual(0);
          expect(points).toBeLessThanOrEqual(10);
        }
      }
    }
  });

  it('reaches at least 4 distinct values across the credential x NAICS-intensity combinations', () => {
    // Documents the 5 distinct reachable totals from knowledgePointsFor's
    // comment: 2, 4, 5, 7, 10.
    const values = new Set([
      knowledgePointsFor({
        isLicensedTrade: true,
        licenseOrRegistrationCount: 2,
        naicsCodes: ['54'], // licensed + knowledge-intensive -> 2
      }),
      knowledgePointsFor({
        isLicensedTrade: true,
        licenseOrRegistrationCount: 2,
        naicsCodes: ['44'], // licensed + not knowledge-intensive -> 5
      }),
      knowledgePointsFor({
        isLicensedTrade: false,
        licenseOrRegistrationCount: 1,
        naicsCodes: ['54'], // one matched requirement + knowledge-intensive -> 4
      }),
      knowledgePointsFor({
        isLicensedTrade: false,
        licenseOrRegistrationCount: 1,
        naicsCodes: ['44'], // one matched requirement + not knowledge-intensive -> 7
      }),
      knowledgePointsFor({
        isLicensedTrade: false,
        licenseOrRegistrationCount: 0,
        naicsCodes: ['54'], // unlicensed + knowledge-intensive -> 7
      }),
      knowledgePointsFor({
        isLicensedTrade: false,
        licenseOrRegistrationCount: 0,
        naicsCodes: ['44'], // unlicensed + not knowledge-intensive -> 10
      }),
    ]);
    expect(values.size).toBeGreaterThanOrEqual(4);
    expect([...values].sort((a, b) => a - b)).toEqual([2, 4, 5, 7, 10]);
  });

  it('uses the real Compliance-OS license/registration count as the primary credential signal when available', () => {
    const noRequirement = knowledgePointsFor({
      isLicensedTrade: false,
      licenseOrRegistrationCount: 0,
      naicsCodes: ['44'],
    });
    const oneRequirement = knowledgePointsFor({
      isLicensedTrade: false,
      licenseOrRegistrationCount: 1,
      naicsCodes: ['44'],
    });
    const twoRequirements = knowledgePointsFor({
      isLicensedTrade: false,
      licenseOrRegistrationCount: 2,
      naicsCodes: ['44'],
    });
    expect(noRequirement).toBeGreaterThan(oneRequirement);
    expect(oneRequirement).toBeGreaterThan(twoRequirements);
  });

  it('lets real Compliance-OS data override an incorrect LICENSED_TRADE_PATTERN guess in either direction', () => {
    // Regex says licensed, real data confirms zero matched requirements —
    // should score the same as a case that never looked licensed at all.
    const regexWrongPositive = knowledgePointsFor({
      isLicensedTrade: true,
      licenseOrRegistrationCount: 0,
      naicsCodes: ['44'],
    });
    const genuinelyUnlicensed = knowledgePointsFor({
      isLicensedTrade: false,
      licenseOrRegistrationCount: 0,
      naicsCodes: ['44'],
    });
    expect(regexWrongPositive).toBe(genuinelyUnlicensed);

    // Regex says unlicensed, real data finds matched requirements — should
    // score the same as a case the regex correctly flagged.
    const regexWrongNegative = knowledgePointsFor({
      isLicensedTrade: false,
      licenseOrRegistrationCount: 2,
      naicsCodes: ['44'],
    });
    const genuinelyLicensed = knowledgePointsFor({
      isLicensedTrade: true,
      licenseOrRegistrationCount: 2,
      naicsCodes: ['44'],
    });
    expect(regexWrongNegative).toBe(genuinelyLicensed);
  });

  it('falls back to the LICENSED_TRADE_PATTERN guess (binary) only when real license/registration data is unavailable', () => {
    const unlicensedGuess = knowledgePointsFor({
      isLicensedTrade: false,
      licenseOrRegistrationCount: undefined,
      naicsCodes: ['44'],
    });
    const licensedGuess = knowledgePointsFor({
      isLicensedTrade: true,
      licenseOrRegistrationCount: undefined,
      naicsCodes: ['44'],
    });
    expect(unlicensedGuess).toBeGreaterThan(licensedGuess);
  });

  it('scores knowledge-intensive NAICS sectors (54/61/52) lower than non-intensive sectors at the same credential level', () => {
    // Same credential inputs throughout — only the NAICS code changes — so
    // any difference is attributable to the independent NAICS
    // knowledge-intensity signal, not the credential signal.
    for (const code of ['54', '61', '52']) {
      const intensive = knowledgePointsFor({
        isLicensedTrade: false,
        licenseOrRegistrationCount: 0,
        naicsCodes: [code],
      });
      const notIntensive = knowledgePointsFor({
        isLicensedTrade: false,
        licenseOrRegistrationCount: 0,
        naicsCodes: ['44'],
      });
      expect(intensive).toBeLessThan(notIntensive);
    }
  });

  it('treats an unlicensed knowledge-intensive sector as harder than a licensed non-knowledge-intensive one is easy, since neither axis alone tells the whole story', () => {
    // A licensed trade that is NOT knowledge-intensive (e.g. a barbershop)
    // and an unlicensed sector that IS knowledge-intensive (e.g. software
    // consulting) should not simply invert each other under the old binary
    // — both should land below the true best case (unlicensed AND not
    // knowledge-intensive) and above the true worst case (licensed AND
    // knowledge-intensive).
    const best = knowledgePointsFor({
      isLicensedTrade: false,
      licenseOrRegistrationCount: 0,
      naicsCodes: ['44'],
    });
    const worst = knowledgePointsFor({
      isLicensedTrade: true,
      licenseOrRegistrationCount: 2,
      naicsCodes: ['54'],
    });
    const licensedSimpleTrade = knowledgePointsFor({
      isLicensedTrade: true,
      licenseOrRegistrationCount: 2,
      naicsCodes: ['44'],
    });
    const unlicensedKnowledgeWork = knowledgePointsFor({
      isLicensedTrade: false,
      licenseOrRegistrationCount: 0,
      naicsCodes: ['54'],
    });
    expect(licensedSimpleTrade).toBeLessThan(best);
    expect(licensedSimpleTrade).toBeGreaterThan(worst);
    expect(unlicensedKnowledgeWork).toBeLessThan(best);
    expect(unlicensedKnowledgeWork).toBeGreaterThan(worst);
  });
});

describe('licensingComplexityPointsFor', () => {
  it('falls back to the original flat-count tiers when composition data (licenseCount) is unavailable', () => {
    expect(
      licensingComplexityPointsFor({ requirementCount: undefined, licenseCount: undefined }),
    ).toBe(5);
    expect(
      licensingComplexityPointsFor({ requirementCount: 2, licenseCount: undefined }),
    ).toBe(10);
    expect(
      licensingComplexityPointsFor({ requirementCount: 7, licenseCount: undefined }),
    ).toBe(6);
    expect(
      licensingComplexityPointsFor({ requirementCount: 15, licenseCount: undefined }),
    ).toBe(2);
  });

  it('scores a LICENSE-heavy composition as harder than a REGISTRATION/FILING-heavy composition of the exact same total requirementCount', () => {
    // This is the core fix: barrierPoints' compliance-breadth signal already
    // scores requirementCount=6 identically regardless of composition (see
    // requirementBreadthSignalFor) — licensingComplexityPointsFor now has to
    // actually differ here, or the double-counting problem isn't fixed.
    const licenseHeavy = licensingComplexityPointsFor({
      requirementCount: 6,
      licenseCount: 5,
    });
    const registrationHeavy = licensingComplexityPointsFor({
      requirementCount: 6,
      licenseCount: 0,
    });
    expect(licenseHeavy).toBeLessThan(registrationHeavy);
    expect(registrationHeavy).toBe(10);
  });

  it('scores a roughly-half LICENSE composition strictly between the all-LICENSE and no-LICENSE cases for the same total', () => {
    const allLicense = licensingComplexityPointsFor({ requirementCount: 6, licenseCount: 6 });
    const halfLicense = licensingComplexityPointsFor({ requirementCount: 6, licenseCount: 3 });
    const noLicense = licensingComplexityPointsFor({ requirementCount: 6, licenseCount: 0 });
    expect(allLicense).toBeLessThan(halfLicense);
    expect(halfLicense).toBeLessThan(noLicense);
  });

  it('treats a confirmed zero requirementCount as the easiest case regardless of licenseCount', () => {
    expect(
      licensingComplexityPointsFor({ requirementCount: 0, licenseCount: 0 }),
    ).toBe(10);
  });

  it('never exceeds the 0-10 range regardless of inputs', () => {
    const requirementCounts = [0, 1, 2, 5, 6, 10, 11, 20, undefined];
    const licenseCounts = [0, 1, 2, 5, 6, 10, 20, undefined];
    for (const requirementCount of requirementCounts) {
      for (const licenseCount of licenseCounts) {
        const points = licensingComplexityPointsFor({ requirementCount, licenseCount });
        expect(points).toBeGreaterThanOrEqual(0);
        expect(points).toBeLessThanOrEqual(10);
      }
    }
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

describe('laborPointsFor', () => {
  it('uses the percentile-cache decile bucket over the hardcoded tiers when a bucket is provided', () => {
    // unemploymentRate alone (2%) would hit the lowest hardcoded tier (4),
    // but a real bucket of 10 (loosest labor market nationally) should win
    // and map to the top of the 0-20 budget instead — naicsCodes chosen as
    // a labor-intensive sector (23) so no blending dilutes the result.
    const points = laborPointsFor({
      naicsCodes: ['23'],
      unemploymentRate: 2,
      laborPercentileBucket: 10,
    });
    expect(points).toBe(20);
  });

  it('maps decile buckets 1-10 onto the 0-20 budget via bucket * 2', () => {
    for (let bucket = 1; bucket <= 10; bucket += 1) {
      expect(
        laborPointsFor({
          naicsCodes: ['23'],
          unemploymentRate: 5,
          laborPercentileBucket: bucket,
        }),
      ).toBe(bucket * 2);
    }
  });

  it('falls back to the hardcoded unemployment-rate tiers when laborPercentileBucket is null (cache not populated)', () => {
    // Same fallback tiers scoreStartupDifficulty always used: >6% -> 20,
    // >4% -> 14, >2.5% -> 8, else -> 4. naicsCodes is labor-intensive so the
    // blend step is a no-op and doesn't obscure the fallback tier value.
    expect(
      laborPointsFor({ naicsCodes: ['23'], unemploymentRate: 7, laborPercentileBucket: null }),
    ).toBe(20);
    expect(
      laborPointsFor({ naicsCodes: ['23'], unemploymentRate: 5, laborPercentileBucket: null }),
    ).toBe(14);
    expect(
      laborPointsFor({ naicsCodes: ['23'], unemploymentRate: 3, laborPercentileBucket: null }),
    ).toBe(8);
    expect(
      laborPointsFor({ naicsCodes: ['23'], unemploymentRate: 1, laborPercentileBucket: null }),
    ).toBe(4);
  });

  it('falls back to the same hardcoded tiers when laborPercentileBucket is simply omitted (undefined)', () => {
    expect(laborPointsFor({ naicsCodes: ['23'], unemploymentRate: 7 })).toBe(20);
  });

  it('gives a neutral midpoint-leaning contribution when unemployment data itself is missing entirely', () => {
    // hasLaborData=false path (unemploymentRate undefined, no bucket) -> 10
    // is the hardcoded neutral tier, and NAICS 23 is labor-intensive so
    // nothing blends it further.
    expect(
      laborPointsFor({ naicsCodes: ['23'], unemploymentRate: undefined }),
    ).toBe(10);
  });

  it('measurably pulls the score toward neutral for a labor-light sector versus a labor-intensive one at the same unemployment rate', () => {
    const intensive = laborPointsFor({
      naicsCodes: ['72'], // food service — labor-intensive
      unemploymentRate: 10, // top hardcoded tier -> snapshot 20
      laborPercentileBucket: null,
    });
    const light = laborPointsFor({
      naicsCodes: ['54'], // professional services — labor-light
      unemploymentRate: 10,
      laborPercentileBucket: null,
    });
    expect(intensive).toBe(20);
    // 50% blend toward the neutral midpoint of 10: round(20*0.5+10*0.5)=15.
    expect(light).toBe(15);
    expect(light).toBeLessThan(intensive);

    // And the same comparison at the tight end of the range: a light
    // sector's score should be pulled UP toward neutral, not just down.
    const intensiveTight = laborPointsFor({
      naicsCodes: ['72'],
      unemploymentRate: 1, // bottom hardcoded tier -> snapshot 4
      laborPercentileBucket: null,
    });
    const lightTight = laborPointsFor({
      naicsCodes: ['54'],
      unemploymentRate: 1,
      laborPercentileBucket: null,
    });
    expect(intensiveTight).toBe(4);
    expect(lightTight).toBe(7); // round(4*0.5+10*0.5)=7
    expect(lightTight).toBeGreaterThan(intensiveTight);
  });

  it('gives a mixed/unclassified sector the full unblended range, same as a labor-intensive one', () => {
    // NAICS 53 (real estate) has no dedicated tier on either axis.
    const mixed = laborPointsFor({
      naicsCodes: ['53'],
      unemploymentRate: 10,
      laborPercentileBucket: null,
    });
    expect(mixed).toBe(20);
  });

  it('a trend modifier nudges the score up for a loosening market and down for a tightening one', () => {
    const base = laborPointsFor({
      naicsCodes: ['23'],
      unemploymentRate: 5, // mid hardcoded tier -> snapshot 14
      laborPercentileBucket: null,
      laborTrendPercent: null,
    });
    const loosening = laborPointsFor({
      naicsCodes: ['23'],
      unemploymentRate: 5,
      laborPercentileBucket: null,
      laborTrendPercent: 10, // unemployment rising sharply -> loosening
    });
    const tightening = laborPointsFor({
      naicsCodes: ['23'],
      unemploymentRate: 5,
      laborPercentileBucket: null,
      laborTrendPercent: -10, // unemployment falling sharply -> tightening
    });
    expect(loosening).toBeGreaterThan(base);
    expect(tightening).toBeLessThan(base);
  });

  it('prefers the trend percentile bucket over the raw trendPercent fallback when both are provided', () => {
    const bucketDriven = laborPointsFor({
      naicsCodes: ['23'],
      unemploymentRate: 5,
      laborPercentileBucket: null,
      laborTrendBucket: 10, // strongest loosening bucket
      laborTrendPercent: -10, // would otherwise read as strongly tightening
    });
    const percentDriven = laborPointsFor({
      naicsCodes: ['23'],
      unemploymentRate: 5,
      laborPercentileBucket: null,
      laborTrendPercent: -10,
    });
    expect(bucketDriven).toBeGreaterThan(percentDriven);
  });

  it('never exceeds the 0-20 range regardless of inputs, including at the extremes with a maxed trend modifier', () => {
    const naicsOptions = [['23'], ['54'], ['53'], ['31-33'], ['61']];
    const rates = [undefined, 0, 1, 2.5, 4, 6, 10, 25];
    const buckets: Array<number | null | undefined> = [undefined, null, 1, 5, 10];
    const trendPercents: Array<number | null | undefined> = [undefined, null, -100, -5, 0, 5, 100];
    for (const naicsCodes of naicsOptions) {
      for (const unemploymentRate of rates) {
        for (const laborPercentileBucket of buckets) {
          for (const laborTrendPercent of trendPercents) {
            const points = laborPointsFor({
              naicsCodes,
              unemploymentRate,
              laborPercentileBucket,
              laborTrendPercent,
            });
            expect(points).toBeGreaterThanOrEqual(0);
            expect(points).toBeLessThanOrEqual(20);
          }
        }
      }
    }
  });
});

describe('scoreStartupDifficulty labor signal wiring', () => {
  it('uses laborPercentileBucket end-to-end and names the decile in the reasons text', () => {
    const result = scoreStartupDifficulty({
      industry: 'Concrete Contractor',
      businessIdea: 'concrete contractor serving commercial developers',
      naicsCodes: ['23'],
      customerType: 'B2B',
      unemploymentRate: 1, // would hit the lowest hardcoded tier on its own
      laborPercentileBucket: 10, // but the cache says the loosest decile
    });
    const laborReason = result.reasons.find((r) => r.toLowerCase().includes('decile'));
    expect(laborReason).toBeDefined();
    expect(laborReason?.toLowerCase()).toContain('decile 10 of 10');
  });

  it('falls back to describing the hardcoded tiers when laborPercentileBucket is null', () => {
    const result = scoreStartupDifficulty({
      industry: 'Concrete Contractor',
      businessIdea: 'concrete contractor serving commercial developers',
      naicsCodes: ['23'],
      customerType: 'B2B',
      unemploymentRate: 5,
      laborPercentileBucket: null,
    });
    const laborReason = result.reasons.find((r) => r.toLowerCase().includes('unemployment rate is'));
    expect(laborReason).toBeDefined();
    expect(laborReason?.toLowerCase()).toContain('fallback tiers');
  });

  it('mentions the trend direction in the reasons text when trend data is available', () => {
    const result = scoreStartupDifficulty({
      industry: 'Concrete Contractor',
      businessIdea: 'concrete contractor serving commercial developers',
      naicsCodes: ['23'],
      customerType: 'B2B',
      unemploymentRate: 5,
      laborTrendPercent: 10,
    });
    const laborReason = result.reasons.find((r) => r.toLowerCase().includes('loosening'));
    expect(laborReason).toBeDefined();
  });

  it('never lets laborPoints push the total category score outside 0-100', () => {
    const result = scoreStartupDifficulty({
      industry: 'Concrete Contractor',
      businessIdea: 'concrete contractor serving commercial developers',
      naicsCodes: ['23'],
      customerType: 'B2B',
      unemploymentRate: 10,
      laborPercentileBucket: 10,
      laborTrendBucket: 10,
      requirementCount: 0,
      bondOrInsuranceCount: 0,
      licenseOrRegistrationCount: 0,
    });
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});
