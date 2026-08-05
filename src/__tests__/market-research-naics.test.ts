import { describe, it, expect } from 'vitest';
import { inferNaicsCodes } from '../api/routes/integrations/market-research.js';

describe('inferNaicsCodes', () => {
  it('returns a single code for a plain single-activity idea', () => {
    const result = inferNaicsCodes('Concrete Contractor', 'we pour driveways and sidewalks');
    expect(result.codes).toEqual(['23']);
    expect(result.matched).toBe(true);
  });

  it('detects a vertically-integrated idea that both manufactures and installs', () => {
    const result = inferNaicsCodes(
      'Concrete Contractor',
      'a flatwork company that manufactures all the materials for flatwork (concrete, aggregate, forms, stakes, etc) as well as actually doing the flatwork (placements)',
    );
    expect(result.codes).toContain('23');
    expect(result.codes).toContain('31-33');
    expect(result.codes).toHaveLength(2);
    expect(result.matched).toBe(true);
  });

  it('caps at two codes when more than two signals are present', () => {
    const result = inferNaicsCodes(
      'Retail Store',
      'we manufacture furniture, sell it in our retail store, and also do home construction remodeling',
    );
    expect(result.codes.length).toBeLessThanOrEqual(2);
  });

  it('falls back to Professional Services code and reports no match when nothing matches', () => {
    const result = inferNaicsCodes('', 'a truly novel idea with no clear category');
    expect(result.codes).toEqual(['54']);
    expect(result.matched).toBe(false);
  });

  describe('establishmentCodes', () => {
    it('mirrors codes for non-manufacturing ideas', () => {
      const result = inferNaicsCodes('Concrete Contractor', 'we pour driveways and sidewalks');
      expect(result.establishmentCodes).toEqual(result.codes);
    });

    it('refines the broad manufacturing sector code to a specific subsector for a boat/yacht idea', () => {
      // Reported bug: "yacht manufacturer" was resolving establishment
      // counts against the entire "31-33" Manufacturing sector (30,000+
      // QCEW establishments) instead of boat/ship building specifically.
      const result = inferNaicsCodes('Heavy Manufacturing', 'yacht manufacturer');
      expect(result.codes).toEqual(['31-33']);
      expect(result.establishmentCodes).toEqual(['3366']);
    });

    it('refines to Food Manufacturing for a food-production idea', () => {
      // "Food Manufacturing" (industry) and "food production" (idea) also
      // trigger the separate food-service ("72") code — expected, since
      // this function blends codes across a compound idea — so this only
      // asserts the manufacturing slot ("31-33") specifically refines to
      // "311" rather than requiring an exact two-code array.
      const result = inferNaicsCodes(
        'Food Manufacturing',
        'a co-packer doing packaged food production for regional grocers',
      );
      expect(result.codes).toContain('31-33');
      expect(result.establishmentCodes).toContain('311');
      expect(result.establishmentCodes).toHaveLength(result.codes.length);
    });

    it('refines to Chemical Manufacturing for a chemical-production idea', () => {
      const result = inferNaicsCodes(
        'Chemical Manufacturing',
        'an industrial chemical manufacturing plant',
      );
      expect(result.codes).toEqual(['31-33']);
      expect(result.establishmentCodes).toEqual(['325']);
    });

    it('leaves the broad sector code as-is when no specific product line is named', () => {
      const result = inferNaicsCodes(
        'Light Manufacturing',
        'a light manufacturing operation with small production runs',
      );
      expect(result.codes).toEqual(['31-33']);
      expect(result.establishmentCodes).toEqual(['31-33']);
    });
  });
});
